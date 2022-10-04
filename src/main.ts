import * as core from '@actions/core'
import * as github from '@actions/github'
import * as yaml from 'js-yaml'

// {name, content, regexes, author_association, skip-if, remove-if, mode}
type item_t = Map<string, any>

async function run(): Promise<void> {
  try {
    // Configuration parameters
    const configPath: string = core.getInput('configuration-path', {
      required: true
    })
    const token: string = core.getInput('repo-token', {required: true})
    const notBefore: number = Date.parse(
      core.getInput('not-before', {required: false})
    )
    const includeTitle: number = parseInt(
      core.getInput('include-title', {required: false})
    )
    const syncLabels: number = parseInt(
      core.getInput('sync-labels', {required: false})
    )

    const eventInfo: item_t = getEventInfo()
    const event_name: string = eventInfo.get('event_name')
    const issue_number: number | number[] = eventInfo.get('issue_number')
    const title: string = eventInfo.get('title')
    const body: string = eventInfo.get('body')
    const created_at: string = eventInfo.get('created_at')
    const author_association: string = eventInfo.get('author_association')
    if (core.isDebug()) {
      core.debug(`event_name: ${event_name}`)
      core.debug(`issue_number: ${issue_number}`)
      core.debug(`title: ${title}`)
      core.debug(`body: ${body}`)
      core.debug(`created_at: ${created_at}`)
      core.debug(`author_association: ${author_association}`)
    }
    // A client to load data from GitHub
    const client = github.getOctokit(token)

    if (event_name === 'push' /* || event_name === 'commit_comment'*/) {
      if (issue_number && Array.isArray(issue_number)) {
        for (const a_issue_number of issue_number) {
          core.notice(`This push fixed issue #${a_issue_number}.`)
          addLabels(client, a_issue_number, ['fixed'])
        }
      }
    } else {
      if (Array.isArray(issue_number)) {
        throw Error(`unknown error`)
      }
      // If the notBefore parameter has been set to a valid timestamp,
      // exit if the current issue was created before notBefore
      if (notBefore) {
        const createdAt: number = Date.parse(created_at)
        core.info(`Issue is created at ${created_at}.`)
        if (Number.isNaN(createdAt)) {
          throw Error(`cannot deduce \`createdAt\` from ${created_at}`)
        } else if (createdAt < notBefore) {
          core.notice(
            'Issue is before `notBefore` configuration parameter. Exiting...'
          )
          return
        }
      } else {
        core.debug(`Parameter \`notBefore\` is not set or is set invalid.`)
      }

      // Load our regex rules from the configuration path
      const itemsPromise: Promise<[item_t[], item_t[]]> = getLabelCommentArrays(
        client,
        configPath,
        syncLabels
      )
      // Get the labels have been added to the current issue
      const labelsPromise: Promise<Set<string>> = getLabels(
        client,
        issue_number
      )

      const [labelParams, commentParams]: [item_t[], item_t[]] =
        await itemsPromise
      const issueLabels: Set<string> = await labelsPromise

      let issueContent = ''
      if (includeTitle === 1) {
        issueContent += `${title}\n\n`
      }
      issueContent += body

      core.info(`Content of issue #${issue_number}:\n${issueContent}`)

      // labels to be added & removed
      let [addLabelItems, removeLabelItems]: [string[], string[]] = itemAnalyze(
        labelParams,
        issueContent,
        author_association,
        event_name
      )

      // comments to be added
      const addCommentItems: string[] = itemAnalyze(
        commentParams,
        issueContent,
        author_association,
        event_name
      )[0]

      if (core.isDebug()) {
        core.debug(`labels have been added: [${Array.from(issueLabels)}]`)
        core.debug(`labels to be added: [${addLabelItems.toString()}]`)
        core.debug(`labels to be removed: [${removeLabelItems.toString()}]`)
      }

      // some may have been added, remove them
      addLabelItems = addLabelItems.filter(label => !issueLabels.has(label))
      if (addLabelItems.length > 0) {
        core.info(
          `Adding labels ${addLabelItems.toString()} to issue #${issue_number}`
        )
        addLabels(client, issue_number, addLabelItems)
      }

      if (syncLabels) {
        for (const label of removeLabelItems) {
          // skip labels that have not been added
          if (issueLabels.has(label)) {
            core.info(`Removing label ${label} from issue #${issue_number}`)
            removeLabel(client, issue_number, label)
          }
        }
      }

      if (addCommentItems.length > 0) {
        for (const itemBody of addCommentItems) {
          core.info(`Comment ${itemBody} to issue #${issue_number}`)
          addComment(client, issue_number, itemBody)
        }
      }
    }
  } catch (error) {
    if (error instanceof Error) {
      core.error(error)
      core.setFailed(error.message)
    }
  }
}

function itemAnalyze(
  itemMap: item_t[],
  issueContent: string,
  author_association: string,
  event_name: string
): [string[], string[]] {
  const addItems: string[] = []
  const addItemNames: Set<string> = new Set()
  const removeItems: string[] = []

  for (const itemParams of itemMap) {
    const item: string = itemParams.get('content')
    const itemName: string = itemParams.get('name')
    const globs: string[] = itemParams.get('regexes')
    const allowedAuthorAssociation: string[] =
      itemParams.get('author_association')
    const mode: item_t = itemParams.get('mode')
    const skipIf: string[] = itemParams.get('skip-if')
    const removeIf: string[] = itemParams.get('remove-if')
    const needAdd: Boolean = checkEvent(event_name, mode, 'add')
    const needRemove: Boolean = checkEvent(event_name, mode, 'remove')
    if (
      (needAdd || needRemove) &&
      skipIf.filter(x => addItemNames.has(x)).length === 0
    ) {
      if (
        removeIf.filter(x => addItemNames.has(x)).length === 0 &&
        checkAuthorAssociation(author_association, allowedAuthorAssociation) &&
        checkRegexes(issueContent, globs)
      ) {
        if (needAdd) {
          // contents can be duplicated, but only added once (set content="" to skip add)
          if (item !== '' && !addItems.includes(item)) {
            addItems.push(item)
          }
          // add itemName regardless of whether the content is duplicated
          addItemNames.add(itemName)
        }
      } else {
        if (needRemove) {
          // Ibid.
          if (item !== '' && !removeItems.includes(item)) {
            removeItems.push(item)
          }
        }
      }
    } else {
      if (core.isDebug()) {
        core.debug(
          `needAdd = ${needAdd}, needRemove = ${needRemove}, mode = ${JSON.stringify(
            Object.fromEntries(mode.entries())
          )}`
        )
        core.debug(`Ignore item \`${itemName}\`.`)
      }
    }
  }
  return [addItems.filter(item => !removeItems.includes(item)), removeItems]
}

function getEventDetails(issue: any, repr: string): item_t {
  const eventDetails: item_t = new Map()
  try {
    eventDetails.set('issue_number', issue.number ? issue.number : NaN)
    eventDetails.set('title', issue.title ? issue.title : '')
    eventDetails.set('body', issue.body ? issue.body : '')
    eventDetails.set(
      'author_association',
      issue.author_association ? issue.author_association : ''
    )
    eventDetails.set('created_at', issue.created_at ? issue.created_at : '')
  } catch (error) {
    throw Error(`could not get ${repr} from context (${error})`)
  }
  return eventDetails
}

function getIssueNumbersFromMessage(messages: string): number[] {
  let issue_numbers: number[] = []
  const globs = /(?:[Ff]ix|[Cc]lose)\s+(?:#|.*\/issues\/)(\d+)/
  let matchResult = messages.match(globs)
  while (matchResult && matchResult.index) {
    issue_numbers.push(parseInt(RegExp.$1))
    messages = messages.substr(matchResult.index + matchResult[0].length)
    matchResult = messages.match(globs)
  }
  return issue_numbers
}

function getPushEventDetails(payload: any): item_t {
  const eventDetails: item_t = new Map()
  try {
    let messages = ''
    for (const commit of payload.commits) messages += `${commit.message}\n\n`
    let issue_numbers = getIssueNumbersFromMessage(messages)
    eventDetails.set('issue_number', issue_numbers)
    eventDetails.set('title', '')
    eventDetails.set('body', messages)
    eventDetails.set('author_association', '') // TODO
    eventDetails.set('created_at', '1970-01-01T00:00:00Z') // TODO
  } catch (error) {
    throw Error(`could not get push event details from context (${error})`)
  }
  return eventDetails
}

function getEventInfo(): item_t {
  const payload = github.context.payload
  const event_name: string = github.context.eventName
  if (event_name === 'issues') {
    const eventInfo: item_t = getEventDetails(payload.issue, 'issue')
    eventInfo.set('event_name', event_name)
    return eventInfo
  } else if (
    event_name === 'pull_request_target' ||
    event_name === 'pull_request'
  ) {
    const eventInfo: item_t = getEventDetails(
      payload.pull_request,
      'pull request'
    )
    eventInfo.set('event_name', event_name)
    return eventInfo
  } else if (event_name === 'issue_comment') {
    const eventInfo: item_t = getEventDetails(payload.comment, 'issue comment')
    const issue: item_t = getEventDetails(payload.issue, 'issue')
    eventInfo.set('event_name', event_name)
    eventInfo.set('issue_number', issue.get('issue_number'))
    eventInfo.set('title', issue.get('title'))
    return eventInfo
  } else if (event_name === 'push') {
    const eventInfo: item_t = getPushEventDetails(payload)
    eventInfo.set('event_name', event_name)
    return eventInfo
    // } else if (event_name === 'commit_comment') {
    //   const eventInfo: item_t = getEventDetails(payload.comment, 'commit comment')
    //   const issue_numbers: number[] = getIssueNumbersFromMessage(
    //     eventInfo.get('body')
    //   )
    //   eventInfo.set('issue_number', issue_numbers)
    //   return eventInfo
  } else {
    throw Error(`could not handle event \`${event_name}\``)
  }
}

async function getLabelCommentArrays(
  client: any,
  configurationPath: string,
  syncLabels: number
): Promise<[item_t[], item_t[]]> {
  const response = await client.rest.repos.getContent({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    path: configurationPath,
    ref: github.context.sha
  })

  const data: any = response.data
  if (!data.content) {
    throw Error(`the configuration path provides an invalid file`)
  }

  const configurationContent: string = Buffer.from(
    data.content,
    'base64'
  ).toString('utf8')
  const configObject: any = yaml.load(configurationContent)

  // transform `any` => `item_t[]` or throw if yaml is malformed:
  return getArraysFromObject(configObject, syncLabels)
}

function getItemParamsFromItem(item: any, default_mode: item_t): item_t {
  const isstr = (x: any): Boolean => typeof x === 'string'
  const isstrarr = (x: any): Boolean => Array.isArray(x)
  const isnull = (x: any): Boolean => x === null
  const pred_any2any = (x: any): any => x
  const pred_any2anyarr = (x: any): any[] => [x]
  const pred_2emptystr = (): string => ''

  const str2str: item_t = new Map().set('cond', isstr).set('pred', pred_any2any)
  const str2strarr: item_t = new Map()
    .set('cond', isstr)
    .set('pred', pred_any2anyarr)
  const strarr2strarr: item_t = new Map()
    .set('cond', isstrarr)
    .set('pred', pred_any2any)
  const null2str: item_t = new Map()
    .set('cond', isnull)
    .set('pred', pred_2emptystr)
  const mode_cond_pred: item_t = new Map()
    .set('cond', (): Boolean => true)
    .set('pred', getModeFromObject)

  const configMap: item_t = new Map([
    ['name', [str2str]],
    ['content', [str2str, null2str]],
    ['author_association', [str2strarr, strarr2strarr]],
    ['regexes', [str2strarr, strarr2strarr]],
    ['mode', [mode_cond_pred]],
    ['skip-if', [str2strarr, strarr2strarr]],
    ['remove-if', [str2strarr, strarr2strarr]]
  ])
  const itemParams: item_t = new Map()
  for (const key in item) {
    if (configMap.has(key)) {
      const value = item[key]
      const cond_preds: item_t[] = configMap.get(key)
      for (const cond_pred of cond_preds) {
        const cond = cond_pred.get('cond')
        const pred = cond_pred.get('pred')
        if (
          typeof cond == 'function' &&
          typeof pred == 'function' &&
          cond(value)
        ) {
          itemParams.set(key, pred(value))
          break
        }
      }
      if (!itemParams.has(key)) {
        const itemRepr: string = itemParams.has('name')
          ? itemParams.get('name')
          : 'some item'
        throw Error(
          `found unexpected \`${value}\` (type \`${typeof key}\`) of field \`${key}\` in ${itemRepr}`
        )
      }
    } else {
      throw Error(`found unexpected field \`${key}\``)
    }
  }

  if (!itemParams.has('name') || !itemParams.get('name')) {
    throw Error(`some item's name is missing`)
  }

  const itemName: string = itemParams.get('name')
  if (!itemParams.has('content')) {
    itemParams.set('content', itemName)
  }
  if (!itemParams.has('regexes')) {
    itemParams.set('regexes', [])
  }
  if (!itemParams.has('author_association')) {
    itemParams.set('author_association', [])
  }
  if (!itemParams.has('skip-if')) {
    itemParams.set('skip-if', [])
  }
  if (!itemParams.has('remove-if')) {
    itemParams.set('remove-if', [])
  }
  if (!itemParams.has('mode')) {
    itemParams.set('mode', default_mode)
  }
  return itemParams
}

function getModeFromObject(configObject: any): item_t {
  const modeMap: item_t = new Map()
  if (typeof configObject === 'string') {
    modeMap.set(configObject, '__all__')
  } else if (Array.isArray(configObject)) {
    for (const value of configObject) {
      modeMap.set(value, '__all__')
    }
  } else {
    for (const key in configObject) {
      if (configObject[key] === null) {
        modeMap.set(key, '__all__')
      } else {
        modeMap.set(key, configObject[key])
      }
    }
  }
  return modeMap
}

function getItemArrayFromObject(
  configObject: any,
  default_mode: item_t
): item_t[] {
  const itemArray: item_t[] = []
  for (const item of configObject) {
    const itemParams: item_t = getItemParamsFromItem(item, default_mode)
    itemArray.push(itemParams)
  }
  return itemArray
}

function getArraysFromObject(
  configObject: any,
  syncLabels: number
): [item_t[], item_t[]] {
  let labelParamsObject: any = []
  let commentParamsObject: any = []

  let labelParams: item_t[] = []
  let commentParams: item_t[] = []
  let default_mode: item_t | undefined = undefined

  for (const key in configObject) {
    if (key === 'labels') {
      labelParamsObject = configObject[key]
    } else if (key === 'comments') {
      commentParamsObject = configObject[key]
    } else if (key === 'default-mode') {
      default_mode = getModeFromObject(configObject[key])
    } else {
      throw Error(
        `found unexpected key for ${key} (should be \`labels\` or \`comments\`)`
      )
    }
  }
  if (default_mode === undefined) {
    if (syncLabels === 1) {
      default_mode = new Map([
        ['pull_request', ['add', 'remove']],
        ['pull_request_target', ['add', 'remove']],
        ['issue', ['add', 'remove']],
        ['issue_comment', ['add', 'remove']]
      ])
    } else if (syncLabels === 0) {
      default_mode = new Map([
        ['pull_request', ['add']],
        ['pull_request_target', ['add']],
        ['issue', ['add']],
        ['issue_comment', ['add']]
      ])
    } else {
      throw Error(
        `found unexpected value of syncLabels (${syncLabels}, should be 0 or 1)`
      )
    }
  }
  labelParams = getItemArrayFromObject(labelParamsObject, default_mode)
  commentParams = getItemArrayFromObject(commentParamsObject, default_mode)
  return [labelParams, commentParams]
}

function checkRegexes(body: string, regexes: string[]): Boolean {
  let matched

  // If several regex entries are provided we require all of them to match for the label to be applied.
  for (const regEx of regexes) {
    const isRegEx = regEx.match(/^\/(.+)\/(.*)$/)

    if (isRegEx) {
      matched = body.match(new RegExp(isRegEx[1], isRegEx[2]))
    } else {
      matched = body.match(regEx)
    }

    if (!matched) {
      return false
    }
  }
  return true
}

function checkEvent(
  event_name: string,
  mode: item_t,
  type: string // "add", "remove"
): Boolean {
  const event_rule: string[] | string | undefined = mode.get(event_name)
  const type_rule: string[] | string | undefined = mode.get(type)
  return (
    (event_rule !== undefined &&
      (event_rule === '__all__' ||
        event_rule === type ||
        (Array.isArray(event_rule) && event_rule.includes(type)))) ||
    (type_rule !== undefined &&
      (type_rule === '__all__' ||
        type_rule === event_name ||
        (Array.isArray(type_rule) && type_rule.includes(event_name))))
  )
}

function checkAuthorAssociation(
  author_association: string,
  regexes: string[]
): Boolean {
  let matched

  // If several regex entries are provided we require all of them to match for the label to be applied.
  for (const regEx of regexes) {
    const isRegEx = regEx.match(/^\/(.+)\/(.*)$/)

    if (isRegEx) {
      matched = author_association.match(new RegExp(isRegEx[1], isRegEx[2]))
    } else {
      matched = author_association.match(regEx)
    }

    if (!matched) {
      return false
    }
  }
  return true
}

async function getLabels(
  client: any,
  issue_number: number
): Promise<Set<string>> {
  const labels: Set<string> = new Set()
  try {
    const response = await client.rest.issues.listLabelsOnIssue({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      issue_number
    })
    core.debug(`Load labels status ${response.status}`)
    const data = response.data
    for (let i = 0; i < Object.keys(data).length; i++) {
      labels.add(data[i].name)
    }
    return labels
  } catch (error) {
    core.warning(`Unable to load labels. (${error})`)
    return labels
  }
}

async function addLabels(
  client: any,
  issue_number: number,
  labels: string[]
): Promise<void> {
  try {
    const response = await client.rest.issues.addLabels({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      issue_number,
      labels
    })
    core.debug(`Add labels status ${response.status}`)
  } catch (error) {
    core.warning(`Unable to add labels. (${error})`)
  }
}

async function removeLabel(
  client: any,
  issue_number: number,
  name: string
): Promise<void> {
  try {
    const response = await client.rest.issues.removeLabel({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      issue_number,
      name
    })
    core.debug(`Remove label \`${name}\` status ${response.status}`)
  } catch (error) {
    core.warning(`Unable to remove label ${name}. (${error})`)
  }
}

async function addComment(
  client: any,
  issue_number: number,
  body: string
): Promise<void> {
  try {
    const response = await client.rest.issues.createComment({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      issue_number,
      body
    })
    core.debug(
      `Add comment \`${body.split('\n').join('\\n')}\` status ${
        response.status
      }`
    )
  } catch (error) {
    core.warning(
      `Unable to add comment \`${body.split('\n').join('\\n')}\`. (${error})`
    )
  }
}

run()

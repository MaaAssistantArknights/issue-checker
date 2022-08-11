import * as core from '@actions/core'
import * as github from '@actions/github'
import * as yaml from 'js-yaml'

// {name, content, regexes, author_association, disabled-if, mode}
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
    const issue_number: number = eventInfo.get('issue_number')
    const issue_title: string = eventInfo.get('issue_title')
    const issue_body: string = eventInfo.get('issue_body')
    const issue_created_at: string = eventInfo.get('issue_created_at')
    const issue_author_association: string = eventInfo.get(
      'issue_author_association'
    )
    if (core.isDebug()) {
      core.debug(`event_name: ${event_name}`)
      core.debug(`issue_number: ${issue_number}`)
      core.debug(`issue_title: ${issue_title}`)
      core.debug(`issue_body: ${issue_body}`)
      core.debug(`issue_created_at: ${issue_created_at}`)
      core.debug(`issue_author_association: ${issue_author_association}`)
    }
    // A client to load data from GitHub
    const client = github.getOctokit(token)

    if (event_name === 'push') {
      if (issue_number) {
        core.notice(`This push fixed issue #${issue_number}.`)
        addLabels(client, issue_number, ['fixed'])
      }
    } else {
      // If the notBefore parameter has been set to a valid timestamp, exit if the current issue was created before notBefore
      if (notBefore) {
        const issueCreatedAt: number = Date.parse(issue_created_at)
        core.info(`Issue is created at ${issue_created_at}.`)
        if (Number.isNaN(issueCreatedAt)) {
          throw Error(
            `cannot deduce \`issueCreatedAt\` from ${issue_created_at}`
          )
        } else if (issueCreatedAt < notBefore) {
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
        issueContent += `${issue_title}\n\n`
      }
      issueContent += issue_body

      core.info(`Content of issue #${issue_number}:\n${issueContent}`)

      // labels to be added & removed
      let [addLabelItems, removeLabelItems]: [string[], string[]] = itemAnalyze(
        labelParams,
        issueContent,
        issue_author_association,
        event_name
      )

      // comments to be added
      const addCommentItems: string[] = itemAnalyze(
        commentParams,
        issueContent,
        issue_author_association,
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
        for (const body of addCommentItems) {
          core.info(`Comment ${body} to issue #${issue_number}`)
          addComment(client, issue_number, body)
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
  issue_author_association: string,
  event_name: string
): [string[], string[]] {
  const addItems: string[] = []
  const addItemNames: Set<string> = new Set()
  const removeItems: string[] = []

  for (const itemParams of itemMap) {
    const item: string = itemParams.get('content')
    const itemName: string = itemParams.get('name')
    const globs: string[] = itemParams.get('regexes')
    const author_association: string[] = itemParams.get('author_association')
    const mode: item_t = itemParams.get('mode')
    const avoidItems: string[] = itemParams.get('disabled-if')
    if (checkEvent(event_name, mode, undefined)) {
      if (
        avoidItems.filter(x => addItemNames.has(x)).length === 0 &&
        checkAuthorAssociation(issue_author_association, author_association) &&
        checkRegexes(issueContent, globs)
      ) {
        if (checkEvent(event_name, mode, 'add')) {
          addItems.push(item)
          addItemNames.add(itemName)
        }
      } else if (checkEvent(event_name, mode, 'remove')) {
        removeItems.push(item)
      }
    } else {
      core.debug(`mode: ${Array.from(mode).toString()}`)
      core.debug(`Ignore item \`${itemName}\`.`)
    }
  }
  return [addItems, removeItems]
}

function getEventDetails(issue: any, repr: string): item_t {
  const eventDetails: item_t = new Map()
  try {
    eventDetails.set('issue_number', issue.number ? issue.number : NaN)
    eventDetails.set('issue_title', issue.title ? issue.title : '')
    eventDetails.set('issue_body', issue.body ? issue.body : '')
    eventDetails.set(
      'issue_author_association',
      issue.author_association ? issue.author_association : ''
    )
    eventDetails.set(
      'issue_created_at',
      issue.created_at ? issue.created_at : ''
    )
  } catch (error) {
    throw Error(`could not get ${repr} from context (${error})`)
  }
  return eventDetails
}

function getPushEventDetails(payload: any): item_t {
  const eventDetails: item_t = new Map()
  try {
    let messages = ''
    for (const commit of payload.commits) messages += `${commit.message}\n\n`
    let issue_number = NaN
    if (messages.match(/(?:[Ff]ix|[Cc]lose)\s+(?:#|.*\/issues\/)(\d+)/)) {
      issue_number = parseInt(RegExp.$1)
    }
    eventDetails.set('issue_number', issue_number)
    eventDetails.set('issue_title', '')
    eventDetails.set('issue_body', messages)
    eventDetails.set('issue_author_association', '') // TODO
    eventDetails.set('issue_created_at', '1970-01-01T00:00:00Z') // TODO
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
    const issue = getEventDetails(payload.issue, 'issue')
    eventInfo.set('event_name', event_name)
    eventInfo.set('issue_number', issue.get('issue_number'))
    eventInfo.set('issue_title', issue.get('issue_title'))
    return eventInfo
  } else if (event_name === 'push') {
    const eventInfo: item_t = getPushEventDetails(payload)
    eventInfo.set('event_name', event_name)
    return eventInfo
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
  const itemParams: item_t = new Map()
  for (const key in item) {
    if (key === 'name') {
      if (typeof item[key] === 'string') {
        itemParams.set(key, item[key])
      } else {
        throw Error(
          `found unexpected type for item name \`${item[key]}\` (should be string)`
        )
      }
    } else if (key === 'content') {
      if (typeof item[key] === 'string') {
        itemParams.set(key, item[key])
      } else {
        const itemRepr: string = itemParams.has('name')
          ? itemParams.get('name')
          : 'some item'
        throw Error(
          `found unexpected type of field \`content\` in ${itemRepr} (should be string)`
        )
      }
    } else if (key === 'author_association') {
      if (typeof item[key] === 'string') {
        itemParams.set(key, [item[key]])
      } else if (Array.isArray(item[key])) {
        itemParams.set(key, item[key])
      } else {
        const itemRepr: string = itemParams.has('name')
          ? itemParams.get('name')
          : 'some item'
        throw Error(
          `found unexpected type of field \`author_association\` in ${itemRepr} (should be string or array of regex)`
        )
      }
    } else if (key === 'regexes') {
      if (typeof item[key] === 'string') {
        itemParams.set(key, [item[key]])
      } else if (Array.isArray(item[key])) {
        itemParams.set(key, item[key])
      } else {
        const itemRepr: string = itemParams.has('name')
          ? itemParams.get('name')
          : 'some item'
        throw Error(
          `found unexpected type of field \`regexes\` in ${itemRepr} (should be string or array of regex)`
        )
      }
    } else if (key === 'mode') {
      itemParams.set(key, getModeFromObject(item[key]))
    } else if (key === 'disabled-if') {
      if (typeof item[key] === 'string') {
        itemParams.set(key, [item[key]])
      } else if (Array.isArray(item[key])) {
        itemParams.set(key, item[key])
      } else {
        const itemRepr: string = itemParams.has('name')
          ? itemParams.get('name')
          : 'some item'
        throw Error(
          `found unexpected type of field \`disabled-if\` in ${itemRepr} (should be string or array of string)`
        )
      }
    } else {
      throw Error(`found unexpected field \`${key}\``)
    }
  }

  if (!itemParams.has('name')) {
    throw Error(`some item's name is missing`)
  }
  if (!itemParams.has('regexes') && !itemParams.has('author_association')) {
    const itemRepr: string = itemParams.has('name')
      ? itemParams.get('name')
      : 'some item'
    throw Error(
      `${itemRepr}'s \`regexes\` or \`author_association\` are missing`
    )
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
  if (!itemParams.has('disabled-if')) {
    itemParams.set('disabled-if', [])
  }
  if (!itemParams.has('mode')) {
    itemParams.set('mode', default_mode)
  }
  return itemParams
}

function getModeFromObject(configObject: any): item_t {
  const modeMap: item_t = new Map()
  for (const key in configObject) {
    modeMap.set(key, configObject[key])
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

function checkRegexes(issue_body: string, regexes: string[]): boolean {
  let matched

  // If several regex entries are provided we require all of them to match for the label to be applied.
  for (const regEx of regexes) {
    const isRegEx = regEx.match(/^\/(.+)\/(.*)$/)

    if (isRegEx) {
      matched = issue_body.match(new RegExp(isRegEx[1], isRegEx[2]))
    } else {
      matched = issue_body.match(regEx)
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
  type: string | undefined
): boolean {
  return (
    mode.has(event_name) &&
    (type === undefined ||
      mode.get(event_name).includes(type) ||
      mode.get(event_name) === type)
  )
}

function checkAuthorAssociation(
  issue_author_association: string,
  regexes: string[]
): boolean {
  let matched

  // If several regex entries are provided we require all of them to match for the label to be applied.
  for (const regEx of regexes) {
    const isRegEx = regEx.match(/^\/(.+)\/(.*)$/)

    if (isRegEx) {
      matched = issue_author_association.match(
        new RegExp(isRegEx[1], isRegEx[2])
      )
    } else {
      matched = issue_author_association.match(regEx)
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

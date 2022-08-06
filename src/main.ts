import * as core from '@actions/core';
import * as github from '@actions/github';
import { Octokit } from '@octokit/core';
import * as yaml from 'js-yaml';

async function run(): Promise<void> {
  try {
    // Configuration parameters
    const configPath = core.getInput('configuration-path', { required: true });
    const token = core.getInput('repo-token', { required: true });
    const notBefore = Date.parse(core.getInput('not-before', { required: false }));
    const includeTitle = parseInt(core.getInput('include-title', { required: false }));
    const syncLabels = parseInt(core.getInput('sync-labels', { required: false }));

    const issue_number = getIssueOrPullRequestNumber();
    if (issue_number === undefined) {
      console.log('Could not get issue or pull request number from context, exiting');
      return;
    }

    const issue_body = getIssueOrPullRequestBody();
    if (issue_body === undefined) {
      console.log('Could not get issue or pull request body from context, exiting');
      return;
    }

    const issue_title = getIssueOrPullRequestTitle();
    if (issue_title === undefined) {
      console.log('Could not get issue or pull request title from context, exiting');
      return;
    }

    // A client to load data from GitHub
    const client = github.getOctokit(token);

    // If the notBefore parameter has been set to a valid timestamp, exit if the current issue was created before notBefore
    if (notBefore) {
      const issue = client.rest.issues.get({
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        issue_number: issue_number,
      });
      const issueCreatedAt = Date.parse((await issue).data.created_at)
      if (issueCreatedAt < notBefore) {
        console.log("Issue is before `notBefore` configuration parameter. Exiting...")
        process.exit(0);
      }
    }

    // Load our regex rules from the configuration path
    const [labelParams, commentParams]:
      Readonly<[Map<string, [string, string[], string[]]>, Map<string, [string, string[], string[]]>]> =
      await getLabelCommentRegexes(
      client,
      configPath
    );

    let issueContent = ""
    if (includeTitle === 1) {
      issueContent += `${issue_title}\n\n`
    }
    issueContent += issue_body

    const [addLabelItems, removeLabelItems]: [string[], string[]] = itemAnalyze(
      labelParams,
      issueContent,
    );

    const [addCommentItems, removeCommentItems]: [string[], string[]] = itemAnalyze(
      commentParams,
      issueContent,
    );

    if (addLabelItems.length > 0) {
      console.log(`Adding labels ${addLabelItems.toString()} to issue #${issue_number}`)
      addLabels(client, issue_number, addLabelItems)
    }

    if (syncLabels) {
      removeLabelItems.forEach(function (label, index) {
        console.log(`Removing label ${label} from issue #${issue_number}`)
        removeLabel(client, issue_number, label)
      });
    }

    if (addCommentItems.length > 0) {
      addCommentItems.forEach(function (body, index) {
        console.log(`Comment ${body} to issue #${issue_number}`)
        addComment(client, issue_number, body)
      });
    }
  } catch (error) {
    if (error instanceof Error) {
      core.error(error);
      core.setFailed(error.message);
    }
  }
}

function itemAnalyze(
  itemParams: Map<string, [string, string[], string[]]>,
  issueContent: string,
): [string[], string[]] {
  const addItems: string[] = []
  const addItemNames: string[] = []
  const removeItems: string[] = []

  for (const [item, [itemName, globs, avoidItems]] of itemParams.entries()) {
    let removeCurrentItem = false;
    for (const avoidItem of avoidItems) {
      if (avoidItem in addItemNames) {
        removeCurrentItem = true;
        break;
      }
    }
    if (!removeCurrentItem || checkRegexes(issueContent, globs)) {
      addItems.push(item);
      addItemNames.push(itemName);
    }
    else {
      removeItems.push(item);
    }
  }
  return [addItems, removeItems];
}

function getIssueOrPullRequestNumber(): number | undefined {
  const issue = github.context.payload.issue;
  if (issue) {
    return issue.number;
  }

  const pull_request = github.context.payload.pull_request;
  if (pull_request) {
    return pull_request.number;
  }

  return;
}

function getIssueOrPullRequestBody(): string | undefined {
  const issue = github.context.payload.issue;
  if (issue) {
    return issue.body;
  }

  const pull_request = github.context.payload.pull_request;
  if (pull_request) {
    return pull_request.body;
  }

  return;
}

function getIssueOrPullRequestTitle(): string | undefined {
  const issue = github.context.payload.issue;
  if (issue) {
    return issue.title;
  }

  const pull_request = github.context.payload.pull_request;
  if (pull_request) {
    return pull_request.title;
  }

  return;
}

function regexifyConfigPath(configPath: string, version: string) {
  var lastIndex = configPath.lastIndexOf('.')
  return `${configPath.substring(0, lastIndex)}-v${version}.yml`
}

async function getLabelCommentRegexes(
  client: any,
  configurationPath: string
): Promise<[Map<string, [string, string[], string[]]>, Map<string, [string, string[], string[]]>]> {
  const response = await client.rest.repos.getContents({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    path: configurationPath,
    ref: github.context.sha
  });

  const data: any = response.data
  if (!data.content) {
    console.log('The configuration path provided is not a valid file. Exiting')
    process.exit(1);
  }

  const configurationContent: string = Buffer.from(data.content, 'base64').toString('utf8');
  const configObject: any = yaml.load(configurationContent);

  // transform `any` => `Map<string, Map<string, string[]>>` or throw if yaml is malformed:
  return getParamsMapFromObject(configObject);
}

////////////////////

function getItemParamsFromItem(item: any): [string, string, string[], string[]] {
  // if (!Map.isMap(item)) {
  //   throw Error(
  //     `item should be a Map`
  //   );
  // }
  var itemName: string;
  if (!item.has("name")) {
    throw Error(
      `some item's name is missing`
    );
  } else if (typeof item.get("name") === 'string') {
    itemName = item.get("name");
  } else {
    throw Error(
      `found unexpected type for item name \`${item.get("name")}\` (should be string)`
    );
  }

  var itemContent: string;
  if (!item.has("content")) {
    itemContent = "";
  } else if (typeof item.get("content") === 'string') {
    itemContent = item.get("content");
  } else {
    throw Error(
      `found unexpected type for \`content\` in item ${itemName} (should be string)`
    );
  }

  var itemRegexes: string[];
  if (!item.has("regexes")) {
    throw Error(
      `some item's regexes are missing`
    );
  } else if (typeof item.get("regexes") === 'string') {
    itemRegexes = [item.get("regexes")];
  } else if (Array.isArray(item.get("regexes"))) {
    itemRegexes = item.get("regexes");
  } else {
    throw Error(
      `found unexpected type for \`regexes\` in item ${itemName} (should be string or array of regex)`
    );
  }

  var itemAvoid: string[];
  if (!item.has("disabled-if")) {
    itemAvoid = [""];
  } else if (typeof item.get("disabled-if") === 'string') {
    itemAvoid = [item.get("disabled-if")];
  } else if (Array.isArray(item.get("disabled-if"))) {
    itemAvoid = item.get("disabled-if");
  } else {
    throw Error(
      `found unexpected type for \`disabled-if\` in item ${itemName} (should be string or array of regex)`
    );
  }

  return [itemName, itemContent, itemRegexes, itemAvoid];
}

function getItemParamsMapFromObject(configObject: any): Map<string, [string, string[], string[]]> {
  const itemParams: Map<string, [string, string[], string[]]> = new Map();
  // if (!Map.isMap(configObject)) {
  //   throw Error(
  //     `item should be a Map`
  //   );
  // }
  for (const item of configObject) {
    const [itemName, itemContent, itemRegexes, itemAvoid]: [string, string, string[], string[]] = getItemParamsFromItem(item);
    itemParams.set(itemContent, [itemName, itemRegexes, itemAvoid]);
  }

  return itemParams;
}

function getParamsMapFromObject(configObject: any): [Map<string, [string, string[], string[]]>, Map<string, [string, string[], string[]]>] {
  var labelParams: Map<string, [string, string[], string[]]> = new Map();
  var commentParams: Map<string, [string, string[], string[]]> = new Map();
  for (const key in configObject) {
    if (key === 'labels') {
      labelParams = getItemParamsMapFromObject(configObject[key]);
    } else if (key === 'comments') {
      commentParams = getItemParamsMapFromObject(configObject[key]);
    } else {
      throw Error(
        `found unexpected key for ${key} (should be \`labels\` or \`comments\`)`
      );
    }
  }

  return [labelParams, commentParams];
}

////////////////////
function checkRegexes(issue_body: string, regexes: string[]): boolean {
  var found;

  // If several regex entries are provided we require all of them to match for the label to be applied.
  for (const regEx of regexes) {
    const isRegEx = regEx.match(/^\/(.+)\/(.*)$/)

    if (isRegEx) {
      found = issue_body.match(new RegExp(isRegEx[1], isRegEx[2]))
    } else {
      found = issue_body.match(regEx)
    }

    if (!found) {
      return false;
    }
  }
  return true;
}

async function getLabels(
  client: any,
  issue_number: number,
): Promise<string[]> {
  const response = await client.rest.issues.listLabelsOnIssue({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    issue_number: issue_number,
  });
  const data = response.data
  if (response.status != 200) {
    console.log('Unable to load labels. Exiting...')
    process.exit(1);
  }
  const labels: string[] = [];
  for (let i = 0; i < Object.keys(data).length; i++) {
    labels.push(data[i].name)
  }
  return labels;
}

async function addLabels(
  client: any,
  issue_number: number,
  labels: string[]
) {

  await client.rest.issues.addLabels({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    issue_number: issue_number,
    labels: labels
  });
}

async function removeLabel(
  client: any,
  issue_number: number,
  name: string
) {
  await client.rest.issues.removeLabel({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    issue_number: issue_number,
    name: name
  });
}

async function addComment(
  client: any,
  issue_number: number,
  body: string
) {
  await client.rest.issues.addComment({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    issue_number: issue_number,
    body: body
  });
}

run();

import * as core from '@actions/core';
import * as github from '@actions/github';
import { Octokit } from '@octokit/core';
import * as yaml from 'js-yaml';

// content, [name, regexes, disabled-if]
type item_t = Map<string, [string, string[], string[]]>;

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
      core.warning("Could not get issue or pull request number from context. Exiting...");
      return;
    }

    const issue_body = getIssueOrPullRequestBody();
    if (issue_body === undefined) {
      core.warning("Could not get issue or pull request body from context. Exiting...");
      return;
    }

    const issue_title = getIssueOrPullRequestTitle();
    if (issue_title === undefined) {
      core.warning("Could not get issue or pull request title from context. Exiting...");
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
        core.info("Issue is before `notBefore` configuration parameter. Exiting...")
        return;
      }
    }

    // Load our regex rules from the configuration path
    const [labelParams, commentParams]:
      Readonly<[item_t, item_t]> =
      await getLabelCommentRegexes(
      client,
      configPath
    );
    const issueLabels: Set<string> = await getLabels(
      client,
      issue_number
    );

    let issueContent = ""
    if (includeTitle === 1) {
      issueContent += `${issue_title}\n\n`
    }
    issueContent += issue_body
    core.info(`Content of issue #${issue_number}:\n${issueContent}`)

    var [addLabelItems, removeLabelItems]: [string[], string[]] = itemAnalyze(
      labelParams,
      issueContent,
    );

    var [addCommentItems, removeCommentItems]: [string[], string[]] = itemAnalyze(
      commentParams,
      issueContent,
    );

    addLabelItems = addLabelItems.filter(label => !issueLabels.has(label));
    if (addLabelItems.length > 0) {
      core.info(`Adding labels ${addLabelItems.toString()} to issue #${issue_number}`)
      addLabels(client, issue_number, addLabelItems)
    }

    if (syncLabels) {
      removeLabelItems.forEach(function (label, index) {
        if (issueLabels.has(label)) {
          core.info(`Removing label ${label} from issue #${issue_number}`)
          removeLabel(client, issue_number, label)
        }
      });
    }

    if (addCommentItems.length > 0) {
      addCommentItems.forEach(function (body, index) {
        core.info(`Comment ${body} to issue #${issue_number}`)
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
  itemParams: item_t,
  issueContent: string,
): [string[], string[]] {
  const addItems: string[] = []
  const addItemNames: Set<string> = new Set();
  const removeItems: string[] = []

  for (const [item, [itemName, globs, avoidItems]] of itemParams.entries()) {
    if (avoidItems.filter(avoidItem => addItemNames.has(avoidItem)).length == 0 &&
      checkRegexes(issueContent, globs)) {
      addItems.push(item);
      addItemNames.add(itemName);
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

async function getLabelCommentRegexes(
  client: any,
  configurationPath: string
): Promise<[item_t, item_t]> {
  const response = await client.rest.repos.getContent({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    path: configurationPath,
    ref: github.context.sha
  });

  const data: any = response.data
  if (!data.content) {
    throw Error(
      `The configuration path provided is not a valid file. Exiting`
    );
  }

  const configurationContent: string = Buffer.from(data.content, 'base64').toString('utf8');
  const configObject: any = yaml.load(configurationContent);

  // transform `any` => `item_t` or throw if yaml is malformed:
  return getParamsMapFromObject(configObject);
}

function getItemParamsFromItem(item: any): [string, string, string[], string[]] {
  const itemMap: Map<string, any> = new Map();
  for (const key in item) {
    if (key == "name") {
      if (typeof item[key] === 'string') {
        itemMap.set(key, item[key]);
      } else {
        throw Error(
          `found unexpected type for item name \`${item[key]}\` (should be string)`
        );
      }
    } else if (key == "content") {
      if (typeof item[key] === 'string') {
        itemMap.set(key, item[key]);
      } else {
        const itemRepr: string = itemMap.has("name") ? itemMap.get("name") : "some item";
        throw Error(
          `found unexpected type for \`content\` in ${itemRepr} (should be string)`
        );
      }
    } else if (key == "regexes") {
      if (typeof item[key] === 'string') {
        itemMap.set(key, [item[key]]);
      } else if (Array.isArray(item[key])) {
        itemMap.set(key, item[key]);
      } else {
        const itemRepr: string = itemMap.has("name") ? itemMap.get("name") : "some item";
        throw Error(
          `found unexpected type for \`regexes\` in ${itemRepr} (should be string or array of regex)`
        );
      }
    } else if (key == "disabled-if") {
      if (typeof item[key] === 'string') {
        itemMap.set(key, [item[key]]);
      } else if (Array.isArray(item[key])) {
        itemMap.set(key, item[key]);
      } else {
        const itemRepr: string = itemMap.has("name") ? itemMap.get("name") : "some item";
        throw Error(
          `found unexpected type for \`disabled-if\` in ${itemRepr} (should be string or array of string)`
        );
      }
    }
  }

  if (!itemMap.has("name")) {
    throw Error(
      `some item's name is missing`
    );
  }
  if (!itemMap.has("regexes")) {
    const itemRepr: string = itemMap.has("name") ? itemMap.get("name") : "some item";
    throw Error(
      `${itemRepr}'s regexes are missing`
    );
  }

  const itemName: string = itemMap.get("name");
  const itemContent: string = itemMap.has("content") ? itemMap.get("content") : itemName;
  const itemRegexes: string[] = itemMap.get("regexes");
  const itemAvoid: string[] = itemMap.has("disabled-if") ? itemMap.get("disabled-if") : [];
  return [itemName, itemContent, itemRegexes, itemAvoid];
}

function getItemParamsMapFromObject(configObject: any): item_t {
  const itemParams: item_t = new Map();
  for (const item of configObject) {
    const [itemName, itemContent, itemRegexes, itemAvoid]: [string, string, string[], string[]] = getItemParamsFromItem(item);
    itemParams.set(itemContent, [itemName, itemRegexes, itemAvoid]);
  }
  return itemParams;
}

function getParamsMapFromObject(configObject: any): [item_t, item_t] {
  var labelParams: item_t = new Map();
  var commentParams: item_t = new Map();
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

function checkRegexes(issue_body: string, regexes: string[]): boolean {
  var matched;

  // If several regex entries are provided we require all of them to match for the label to be applied.
  for (const regEx of regexes) {
    const isRegEx = regEx.match(/^\/(.+)\/(.*)$/)

    if (isRegEx) {
      matched = issue_body.match(new RegExp(isRegEx[1], isRegEx[2]))
    } else {
      matched = issue_body.match(regEx)
    }

    if (!matched) {
      return false;
    }
  }
  return true;
}

async function getLabels(
  client: any,
  issue_number: number,
): Promise<Set<string>> {
  const labels: Set<string> = new Set();
  try {
    const response = await client.rest.issues.listLabelsOnIssue({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      issue_number: issue_number,
    });
    if (response.status != 200) {
      core.warning("Unable to load labels.");
    } else {
      const data = response.data
      for (let i = 0; i < Object.keys(data).length; i++) {
        labels.add(data[i].name)
      }
    }
    return labels;
  } catch (error) {
    core.warning("Unable to load labels.");
    return labels;
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
      issue_number: issue_number,
      labels: labels
    });
    if (response.status != 200) {
      core.warning("Unable to add labels.");
    }
  } catch (error) {
    throw Error(
      `unable to add labels`
    );
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
      issue_number: issue_number,
      name: name
    });
    if (response.status != 200) {
      core.warning(`Unable to remove label ${name}.`);
    }
  } catch (error) {
    throw Error(
      `unable to remove label ${name}`
    );
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
      issue_number: issue_number,
      body: body
    });
    if (response.status != 200) {
      core.warning(`Unable to add comment ${body}.`);
    }
  } catch (error) {
    throw Error(
      `unable to add comment ${body}`
    );
  }
}

run();

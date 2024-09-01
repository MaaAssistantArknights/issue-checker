# Issue Checker

Automatically label and comments to new issues or pull requests based on the contents.

## Usage

### Create `.github/issue-checker.yml`

Create a `.github/issue-checker.yml` file with a list of labels and regex to match to apply the label.

#### Basic Examples

```yaml
# For labels
labels:
- name: label-1
  # Add `bug` label if issue contains the word `Bug` or `bug`; Remove if not
  content: bug
  regexes: '[Bb]ug'
- name: enhancement
  # Add `enhancement` label if issue match all of the regexes; Remove if not; Skip if the label `bug` have been added;
  regexes: '[Ee]nhancement|[Ff]eature [Rr]equest'
  skip-if:
  - label-1
- name: label-3
  # Add `Collaborator` label if the issue author is a COLLABORATOR.
  content: Collaborator
  author_association: COLLABORATOR
# For comments
comments:
- name: comments-1
  # Comment the content below if issue contains the word `Uploading`
  content:
    "You have some files that did not upload successfully, please re-upload them."
  regexes:
    'Uploading'
- name: comments-2
  # Comment the content below if issue contains the links that include snippets listed in url_list
  content:
    There are unconfirmed links, please visit with caution.
  url_mode: deny
  url_list:
    - example.com/asd
- name: comments-3
  # Comment the content below if issue contains the links that don't include any snippets listed in url_list
  content:
    There are unconfirmed links, please visit with caution.
  url_mode: allow_only
  url_list:
    - example.com/asd
```

The format of the configuration file is shown below.

``` yaml
default-mode:          # optional
  pull_request:        # optional, choices [pull_request, pull_request_target, issues, issue_comment]
  - add                # optional, choices [add, remove]
  - ...
  ...
labels:                # optional, choices [labels, comments]
- name: string         # required
  content: string      # optional, default ${name}
  regexes:             # optional, required if ${author_association} undefined
    string[] | string
  url_mode:            # optional, ignored if ${regexes} exists
    "allow_only" | "deny"
  url_list: string[]   # optional, ignored if ${regexes} exists
  author_association:  # optional, required if ${regexes} undefined
    string
  remove-if:           # optional
    string[] | string
  skip-if:             # optional
    string[] | string
  mode:                # optional
    pull_request:      # optional, choices [pull_request, pull_request_target, issues, issue_comment]
    - add              # optional, choices [add, remove]
    - ...
    ...
- ...
...
```

### Create Workflow

Create a workflow (eg: `.github/workflows/issue-checker.yml` see [Creating a Workflow file](https://help.github.com/en/articles/configuring-a-workflow#creating-a-workflow-file)) to utilize the labeler action with content:

```yaml
name: "Issue Checker"
on:
  issues:
    types: [opened, edited]
  pull_request_target:
    types: [opened, edited]
jobs:
  triage:
    permissions:
      contents: read
      issues: write
      pull-requests: write
    runs-on: ubuntu-latest
    steps:
    - uses: MaaAssistantArknights/issue-checker@v1.11
      with:
        repo-token: "${{ secrets.GITHUB_TOKEN }}"
        configuration-path: .github/issue-checker.yml
        not-before: 2022-08-01T00:00:00Z
        include-title: 0
        sync-labels: 1
```

_Warning: Do not use triggers other than `pull_request`, `pull_request_target`, `issues` and `issue_comment`, unless you know what you are doing._

_Note: This grants access to the `GITHUB_TOKEN` so the action can make calls to GitHub's rest API._

#### Inputs

Various inputs are defined in [`action.yml`](action.yml) to let you configure the issue-checker:

| Name | Description | Default |
| - | - | - |
| `repo-token` | Token to use to authorize label changes. | N/A |
| `configuration-path` | The path to the label configuration file | N/A |
| `sync-labels` | Whether or not to remove labels when not match | 1 |
| `include-title` | Whether or not the title participate in matching | 0 |
| `not-before` | Any issues prior to this timestamp will be ignored (blank to handle all issues) | N/A |

// Copyright 2021 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import {Octokit} from '@octokit/rest';
import {ConfigsStore, OwlBotYamlAndPath} from './configs-store';
import {OctokitFactory} from './octokit-util';
import tmp from 'tmp';
import {
  copyCodeAndAppendOrCreatePullRequest,
  CopyParams,
  copyTagFrom,
  toLocalRepo,
} from './copy-code';
import {getFilesModifiedBySha} from '.';
import {newCmd} from './cmd';
import {CopyStateStore} from './copy-state-store';
import {GithubRepo} from './github-repo';
import {Logger, LoggerWithTimestamp} from './logger';
import {WithNestedCommitDelimiters} from './create-pr';

interface Todo {
  repo: GithubRepo;
  commitHash: string;
  yamlPaths: string[];
}

/**
 * Tests if the commit hash in googleapis-gen's history is older than
 * the config's begin-after-commit-hash.
 * @param yaml The OwlBotYaml or undefined if it couldn't be pulled from the
 *             database.
 * @param commitIndex the index of the commit hash to compare to the config's
 *                    begin-after-commit-hash
 * @param commitHashes the list of commit hashes in googleapi-gen's history,
 *                     in order from newest to oldest.
 */
function isCommitHashTooOld(
  yamls: OwlBotYamlAndPath[] | undefined,
  commitIndex: number,
  commitHashes: string[]
): boolean {
  // Compare to begin-after-commit-hash declared in .OwlBot.yaml.
  let beginAfterCommitHash = '';
  for (const yaml of yamls ?? []) {
    const hash = yaml.yaml['begin-after-commit-hash']?.trim();
    if (hash) {
      beginAfterCommitHash = hash;
      break;
    }
  }
  const beginIndex = beginAfterCommitHash
    ? commitHashes.indexOf(beginAfterCommitHash)
    : -1;
  return beginIndex >= 0 && beginIndex <= commitIndex;
}

/**
 * Scans googleapis-gen and creates pull requests in target repos
 * (ex: nodejs-vision) when corresponding code has been updated.
 * @param sourceRepo normally 'googleapis/googlapis-gen'
 * @param combinePullsThreshold when the number of APIs (.OwlBot.yamls) affected
 *    by a single commit to googleapis-gen exceeds this threshold, combine
 *    the all the changes into a single pull request.
 * @param maxYamlCountPerPullRequest maximum number of yamls (APIs) to combine
 *    in a single pull request.
 * @param draftPullRequests when creating pull requests, make them drafts
 */
export async function scanGoogleapisGenAndCreatePullRequests(
  sourceRepo: string,
  octokitFactory: OctokitFactory,
  configsStore: ConfigsStore,
  cloneDepth = 100,
  copyStateStore: CopyStateStore,
  combinePullsThreshold = Number.MAX_SAFE_INTEGER,
  logger: Logger = console,
  withNestedCommitDelimiters: WithNestedCommitDelimiters = WithNestedCommitDelimiters.No,
  maxYamlCountPerPullRequest: number = Number.MAX_SAFE_INTEGER,
  draftPullRequests = false
): Promise<number> {
  logger = new LoggerWithTimestamp(logger);
  // Clone the source repo.
  const workDir = tmp.dirSync().name;
  // cloneDepth + 1 because the final commit in a shallow clone is grafted: it contains
  // the combined state of all earlier commits, so we don't want to examine it.
  const sourceDir = toLocalRepo(
    sourceRepo,
    workDir,
    logger,
    cloneDepth + 1,
    await octokitFactory.getGitHubShortLivedAccessToken()
  );

  // Collect the history of commit hashes.
  const cmd = newCmd(logger);
  const stdout = cmd(`git log -${cloneDepth} --format=%H`, {cwd: sourceDir});
  const text = stdout.toString('utf8');
  const commitHashes = text
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(x => x);

  const todoStack: Todo[] = [];
  let octokit: null | Octokit = null;

  // Search the commit history for commits that still need to be copied
  // to destination repos.
  for (const [commitIndex, commitHash] of commitHashes.entries()) {
    const commitText = cmd(`git log -1 --pretty=oneline ${commitHash}`, {
      cwd: sourceDir,
    }).toString('utf8');
    let touchedFiles = await getFilesModifiedBySha(sourceDir, commitHash);
    // The regular expressions in an OwlBot.yaml file expect file paths to
    // begin with a slash.
    touchedFiles = touchedFiles.map(f => (f.startsWith('/') ? f : '/' + f));
    logger.info(commitText);
    touchedFiles.forEach(f => logger.info(f));
    const repos = await configsStore.findReposAffectedByFileChanges(
      touchedFiles
    );
    logger.info(`affecting ${repos.length} repos.`);
    repos.forEach(repo => logger.info(repo));
    const stackSize = todoStack.length;
    for (const repo of repos) {
      octokit = octokit ?? (await octokitFactory.getShortLivedOctokit());
      const repoFullName = repo.repo.toString();
      if (isCommitHashTooOld(repo.yamls, commitIndex, commitHashes)) {
        logger.info(
          `Ignoring ${repoFullName} because ${commitHash} is too old.`
        );
        continue;
      }

      const todoYamls = [];
      for (const yaml of repo.yamls) {
        const copyBuildId = await copyStateStore.findBuildForCopy(
          repo.repo,
          copyTagFrom(yaml.path, commitHash)
        );
        if (copyBuildId) {
          logger.info(
            `Found build ${copyBuildId} for ${commitHash} ` +
              `for ${repo.repo.owner}:${repo.repo.repo} ${yaml.path}.`
          );
        } else {
          todoYamls.push(yaml.path);
        }
      }

      if (todoYamls.length > 0) {
        const todos =
          todoYamls.length > combinePullsThreshold
            ? [{repo: repo.repo, yamlPaths: todoYamls, commitHash}]
            : todoYamls.map(yaml => {
                return {repo: repo.repo, yamlPaths: [yaml], commitHash};
              });
        for (const todo of todos) {
          logger.info(
            `Pushing todo onto stack: ${JSON.stringify(todo, undefined, 2)}`
          );
          todoStack.push(todo);
        }
      }
    }
    // We're done searching through the history when all pull requests have
    // been generated for a commit hash.
    if (repos.length > 0 && todoStack.length === stackSize) {
      logger.info(`Created all necessary pull requests for ${commitText}.`);
      break;
    }
  }
  logger.info('Done searching through commit history.');
  logger.info(`${todoStack.length} items in the todo stack.`);

  // Copy files beginning with the oldest commit hash.
  for (const todo of todoStack.reverse()) {
    const params: CopyParams = {
      sourceRepo: sourceDir,
      sourceRepoCommitHash: todo.commitHash,
      destRepo: todo.repo,
      copyStateStore,
      octokitFactory,
      maxYamlCountPerPullRequest,
    };
    await copyCodeAndAppendOrCreatePullRequest(
      params,
      todo.yamlPaths,
      logger,
      withNestedCommitDelimiters,
      draftPullRequests
    );
  }
  return todoStack.length;
}

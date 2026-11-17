// What the real tools send, captured by running them: gh 2.101.0 with GH_DEBUG=api against
// the public cli/cli repository for the reads, and gh and glab 1.128.0 against a local
// stand-in for the writes and for `gh repo view`. The documents are verbatim; only the
// repository and the numbers were changed to the tests' own (`o/r`, pull request 578,
// issue 421).

const repoVars = { owner: 'o', repo: 'r' };

/// GraphQL requests of gh, by the command that sends them: `{ query, variables }`.
export const GH = {
  // gh pr view 578 --json author,isDraft,headRefName
  prViewAuthor: {
    query: `query PullRequestByNumber($owner: String!, $repo: String!, $pr_number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $pr_number) {author{login,...on User{id,name}},isDraft,headRefName,id,number}
    }
  }`,
    variables: { ...repoVars, pr_number: 578 },
  },
  // gh pr view 578 --comments
  prViewDefault: {
    query: `query PullRequestByNumber($owner: String!, $repo: String!, $pr_number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $pr_number) {url,number,title,state,body,author{login,...on User{id,name}},autoMergeRequest {authorEmail,commitBody,commitHeadline,mergeMethod,enabledAt,enabledBy{login,...on User{id,name}}},isDraft,maintainerCanModify,mergeable,additions,deletions,commits{totalCount},baseRefName,headRefName,headRepositoryOwner{id,login,...on User{name}},headRepository{id,name,nameWithOwner},isCrossRepository,reviewRequests(first: 100) {nodes {requestedReviewer {__typename,...on User{login,name},...on Bot{login},...on Team{organization{login}name,slug}}}},reviews(first: 100) {nodes {id,author{login},authorAssociation,submittedAt,body,state,commit{oid},reactionGroups{content,users{totalCount}}}pageInfo{hasNextPage,endCursor}totalCount},assignees(first:100){nodes{id,login,name,databaseId},totalCount},labels(first:100){nodes{id,name,description,color},totalCount},milestone{number,title,description,dueOn},comments(first: 100) {nodes {id,author{login,...on User{id,name}},authorAssociation,body,createdAt,includesCreatedEdit,isMinimized,minimizedReason,reactionGroups{content,users{totalCount}},url,viewerDidAuthor},pageInfo{hasNextPage,endCursor},totalCount},reactionGroups{content,users{totalCount}},createdAt,statusCheckRollup: commits(last: 1) {nodes {commit {statusCheckRollup {contexts(first:100) {nodes {__typename...on StatusContext {context,state,targetUrl,createdAt,description},...on CheckRun {name,checkSuite{workflowRun{workflow{name}}},status,conclusion,startedAt,completedAt,detailsUrl}},pageInfo{hasNextPage,endCursor}}}}}},id}
    }
  }`,
    variables: { ...repoVars, pr_number: 578 },
  },
  prProjectItems: {
    query: 'query PullRequestProjectItems($endCursor:String$name:String!$number:Int!$owner:String!){repository(owner: $owner, name: $name){pullRequest(number: $number){projectItems(first: 100, after: $endCursor){totalCount,nodes{id,project{id,title},status:fieldValueByName(name: "Status"){... on ProjectV2ItemFieldSingleSelectValue{optionId,name}}},pageInfo{hasNextPage,endCursor}}}}}',
    variables: { endCursor: null, name: 'r', number: 578, owner: 'o' },
  },
  // gh pr view 578 --json reviews,comments
  prViewReviews: {
    query: `query PullRequestByNumber($owner: String!, $repo: String!, $pr_number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $pr_number) {reviews(first: 100) {nodes {id,author{login},authorAssociation,submittedAt,body,state,commit{oid},reactionGroups{content,users{totalCount}}}pageInfo{hasNextPage,endCursor}totalCount},comments(first: 100) {nodes {id,author{login,...on User{id,name}},authorAssociation,body,createdAt,includesCreatedEdit,isMinimized,minimizedReason,reactionGroups{content,users{totalCount}},url,viewerDidAuthor},pageInfo{hasNextPage,endCursor},totalCount},id,number}
    }
  }`,
    variables: { ...repoVars, pr_number: 578 },
  },
  // gh pr view 578 --json baseRefName,mergeable
  prViewMergeable: {
    query: `query PullRequestByNumber($owner: String!, $repo: String!, $pr_number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $pr_number) {baseRefName,mergeable,id,number}
    }
  }`,
    variables: { ...repoVars, pr_number: 578 },
  },
  // gh pr checks 578: feature detection, then the checks by node id
  typeFields: {
    query: 'query PullRequest_fields{PullRequest: __type(name: "PullRequest"){fields(includeDeprecated: true){name}},StatusCheckRollupContextConnection: __type(name: "StatusCheckRollupContextConnection"){fields(includeDeprecated: true){name}}}',
  },
  prChecks: {
    query: `query PullRequestStatusChecks($id: ID!, $endCursor: String) {
    node(id: $id) {
      ...on PullRequest {
        statusCheckRollup: commits(last: 1) {nodes {commit {statusCheckRollup {contexts(first:100,after:$endCursor) {nodes {__typename...on StatusContext {context,state,targetUrl,createdAt,description,isRequired(pullRequestId: $id)},...on CheckRun {name,checkSuite{workflowRun{event,workflow{name}}},status,conclusion,startedAt,completedAt,detailsUrl,isRequired(pullRequestId: $id)}},pageInfo{hasNextPage,endCursor}}}}}}
      }
    }
  }`,
    variables: { id: 'PR_578' },
  },
  // gh pr list
  prList: {
    query: `fragment pr on PullRequest{number,title,state,url,headRefName,headRepositoryOwner{id,login,...on User{name}},isCrossRepository,isDraft,createdAt}
    query PullRequestList(
      $owner: String!,
      $repo: String!,
      $limit: Int!,
      $endCursor: String,
      $baseBranch: String,
      $headBranch: String,
      $state: [PullRequestState!] = OPEN
    ) {
      repository(owner: $owner, name: $repo) {
        pullRequests(
          states: $state,
          baseRefName: $baseBranch,
          headRefName: $headBranch,
          first: $limit,
          after: $endCursor,
          orderBy: {field: CREATED_AT, direction: DESC}
        ) {
          totalCount
          nodes {
            ...pr
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }`,
    variables: { ...repoVars, limit: 3, state: ['OPEN'] },
  },
  // gh pr list --author @me --state open
  prSearch: {
    query: `fragment pr on PullRequest{number,title,state,url,headRefName,headRepositoryOwner{id,login,...on User{name}},isCrossRepository,isDraft,createdAt}
    query PullRequestSearch(
      $q: String!,
      $type: SearchType!,
      $limit: Int!,
      $endCursor: String,
    ) {
      search(query: $q, type: $type, first: $limit, after: $endCursor) {
        issueCount
        nodes {
          ...pr
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }`,
    variables: { limit: 30, q: 'author:@me repo:o/r state:open type:pr', type: 'ISSUE_ADVANCED' },
  },
  // gh pr status
  prStatus: {
    query: `fragment pr on PullRequest {number,title,state,url,isDraft,isCrossRepository,headRefName,headRepositoryOwner{id,login,...on User{name}},mergeStateStatus,baseRef{branchProtectionRule{requiresStrictStatusChecks}},autoMergeRequest {authorEmail,commitBody,commitHeadline,mergeMethod,enabledAt,enabledBy{login,...on User{id,name}}},statusCheckRollup: commits(last: 1) {nodes {commit {statusCheckRollup {contexts {checkRunCount,checkRunCountsByState {state,count},statusContextCount,statusContextCountsByState {state,count}}}}}}}
  fragment prWithReviews on PullRequest {...pr,reviewDecision,latestReviews(first: 100) {nodes {author{login},authorAssociation,submittedAt,body,state}}}

  query PullRequestStatus($owner: String!, $repo: String!, $headRefName: String!, $viewerQuery: String!, $reviewerQuery: String!, $per_page: Int = 10) {
    repository(owner: $owner, name: $repo) {
      defaultBranchRef {
        name
      }
      pullRequests(headRefName: $headRefName, first: $per_page, orderBy: { field: CREATED_AT, direction: DESC }) {
        totalCount
        edges {
          node {
            ...prWithReviews
          }
        }
      }
    }

      viewerCreated: search(query: $viewerQuery, type: ISSUE, first: $per_page) {
        totalCount: issueCount
        edges {
          node {
          ...prWithReviews
          }
        }
      }
      reviewRequested: search(query: $reviewerQuery, type: ISSUE, first: $per_page) {
        totalCount: issueCount
        edges {
          node {
          ...pr
          }
        }
      }
    }`,
    variables: { headRefName: '', number: 0, ...repoVars, reviewerQuery: 'repo:o/r state:open review-requested:@me', viewerQuery: 'repo:o/r state:open is:pr author:@me' },
  },
  // gh issue view 421 --comments
  issueView: {
    query: `query IssueByNumber($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      hasIssuesEnabled
      issue: issueOrPullRequest(number: $number) {
        __typename
        ...on Issue{number,url,state,createdAt,title,body,author{login,...on User{id,name}},milestone{number,title,description,dueOn},assignees(first:100){nodes{id,login,name,databaseId},totalCount},labels(first:100){nodes{id,name,description,color},totalCount},reactionGroups{content,users{totalCount}},stateReason,issueType{id,name,description,color},parent{id,number,title,url,state,repository{nameWithOwner}},subIssues(first:100){nodes{id,number,title,url,state,repository{nameWithOwner}},totalCount},subIssuesSummary{total,completed,percentCompleted},comments(first: 100) {nodes {id,author{login,...on User{id,name}},authorAssociation,body,createdAt,includesCreatedEdit,isMinimized,minimizedReason,reactionGroups{content,users{totalCount}},url,viewerDidAuthor},pageInfo{hasNextPage,endCursor},totalCount},blockedBy(first:50){nodes{id,number,title,url,state,repository{nameWithOwner}},totalCount},blocking(first:50){nodes{id,number,title,url,state,repository{nameWithOwner}},totalCount},id}
        ...on PullRequest{number,url,state,createdAt,title,body,author{login,...on User{id,name}},milestone{number,title,description,dueOn},assignees(first:100){nodes{id,login,name,databaseId},totalCount},labels(first:100){nodes{id,name,description,color},totalCount},reactionGroups{content,users{totalCount}},comments(first: 100) {nodes {id,author{login,...on User{id,name}},authorAssociation,body,createdAt,includesCreatedEdit,isMinimized,minimizedReason,reactionGroups{content,users{totalCount}},url,viewerDidAuthor},pageInfo{hasNextPage,endCursor},totalCount},id}
      }
    }
  }`,
    variables: { number: 421, ...repoVars },
  },
  // gh issue list
  issueList: {
    query: `fragment issue on Issue {number,title,url,state,updatedAt,labels(first:100){nodes{id,name,description,color},totalCount},stateReason}
  query IssueList($owner: String!, $repo: String!, $limit: Int, $endCursor: String, $states: [IssueState!] = OPEN, $assignee: String, $author: String, $mention: String) {
    repository(owner: $owner, name: $repo) {
      hasIssuesEnabled
      issues(first: $limit, after: $endCursor, orderBy: {field: CREATED_AT, direction: DESC}, states: $states, filterBy: {assignee: $assignee, createdBy: $author, mentioned: $mention}) {
        totalCount
        nodes {
          ...issue
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }`,
    variables: { limit: 3, ...repoVars, states: ['OPEN'] },
  },
  // gh issue edit 421 --add-assignee @me
  issueForEdit: {
    query: `query IssueByNumber($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      hasIssuesEnabled
      issue: issueOrPullRequest(number: $number) {
        __typename
        ...on Issue{id,number,title,body,url,assignedActors(first: 10) {nodes {...on User {id,login,name,__typename}...on Bot {id,login,__typename}},totalCount}}
        ...on PullRequest{id,number,title,body,url,assignedActors(first: 10) {nodes {...on User {id,login,name,__typename}...on Bot {id,login,__typename}},totalCount}}
      }
    }
  }`,
    variables: { number: 421, ...repoVars },
  },
  userCurrent: { query: 'query UserCurrent{viewer{login}}' },
  assignSelf: {
    query: 'mutation ReplaceActorsForAssignable($input:ReplaceActorsForAssignableInput!){replaceActorsForAssignable(input: $input){__typename}}',
    variables: { input: { assignableId: 'I_421', actorLogins: ['me'] } },
  },
  unassignSelf: {
    query: 'mutation ReplaceActorsForAssignable($input:ReplaceActorsForAssignableInput!){replaceActorsForAssignable(input: $input){__typename}}',
    variables: { input: { assignableId: 'I_421', actorLogins: [] } },
  },
  issueUpdateNothing: {
    query: 'mutation IssueUpdate($input:UpdateIssueInput!){updateIssue(input: $input){__typename}}',
    variables: { input: { id: 'I_421' } },
  },
  // gh issue comment 421 --body hello
  issueComment: {
    query: 'mutation CommentCreate($input:AddCommentInput!){addComment(input: $input){commentEdge{node{url}}}}',
    variables: { input: { subjectId: 'I_421', body: 'hello' } },
  },
  // gh pr create --draft --head fix-421 --base main
  repositoryInfo: {
    query: `fragment repo on Repository {
      id
      databaseId
      name
      owner { login }
      sshUrl
      hasIssuesEnabled
      description
      hasWikiEnabled
      viewerPermission
      defaultBranchRef {
        name
      }
    }
    query RepositoryInfo($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        ...repo
        parent {
          ...repo
        }
        mergeCommitAllowed
        rebaseMergeAllowed
        squashMergeAllowed
      }
    }`,
    variables: { name: 'r', owner: 'o' },
  },
  prForBranch: {
    query: `query PullRequestForBranch($owner: String!, $repo: String!, $headRefName: String!, $states: [PullRequestState!]) {
    repository(owner: $owner, name: $repo) {
      pullRequests(headRefName: $headRefName, states: $states, first: 30, orderBy: { field: CREATED_AT, direction: DESC }) {
        nodes {url,id,number,state,baseRefName,headRefName,isCrossRepository,headRepositoryOwner{id,login,...on User{name}}}
      }
      defaultBranchRef { name }
    }
  }`,
    variables: { headRefName: 'fix-421', ...repoVars, states: ['OPEN'] },
  },
  prCreate: {
    query: `mutation PullRequestCreate($input: CreatePullRequestInput!) {
      createPullRequest(input: $input) {
        pullRequest {
          id
          url
        }
      }
    }`,
    variables: { input: { baseRefName: 'main', body: 'b', draft: true, headRefName: 'fix-421', maintainerCanModify: true, repositoryId: 'R_1', title: 't' } },
  },
  // gh pr ready 578
  prForReady: {
    query: `query PullRequestByNumber($owner: String!, $repo: String!, $pr_number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $pr_number) {id,number,state,isDraft}
    }
  }`,
    variables: { ...repoVars, pr_number: 578 },
  },
  prReady: {
    query: 'mutation PullRequestReadyForReview($input:MarkPullRequestReadyForReviewInput!){markPullRequestReadyForReview(input: $input){pullRequest{id}}}',
    variables: { input: { pullRequestId: 'PR_578' } },
  },
  // What the review prompt has the agent write with `gh api graphql`.
  addThread: {
    query: 'mutation($rid:ID!,$path:String!,$line:Int!,$body:String!){addPullRequestReviewThread(input:{pullRequestReviewId:$rid,path:$path,line:$line,side:RIGHT,body:$body}){thread{id}}}',
    variables: { body: 'x', line: 12, path: 'a.js', rid: 'PRR_mine' },
  },
  addReply: {
    query: 'mutation($t:ID!,$rid:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$t,pullRequestReviewId:$rid,body:$body}){comment{id}}}',
    variables: { t: 'PRRT_578', rid: 'PRR_mine', body: 'Still present as of abc' },
  },
  resolveThread: {
    query: 'mutation($t:ID!){resolveReviewThread(input:{threadId:$t}){thread{id isResolved}}}',
    variables: { t: 'PRRT_578' },
  },
  // gh repo view o/r, which then reads GET /repos/o/r/readme
  repoView: {
    query: 'query RepositoryInfo($owner: String!, $name: String!) {\n\t\trepository(owner: $owner, name: $name) {name,owner{id,login},description}\n\t}',
    variables: { name: 'r', owner: 'o' },
  },
  // gh pr review --comment, gh pr comment, gh pr merge: shortcuts no kind is given.
  prReviewShortcut: {
    query: 'mutation PullRequestReviewAdd($input:AddPullRequestReviewInput!){addPullRequestReview(input:$input){clientMutationId}}',
    variables: { input: { pullRequestId: 'PR_578', body: 'hello', event: 'COMMENT' } },
  },
  prCommentShortcut: {
    query: 'mutation CommentCreate($input:AddCommentInput!){addComment(input: $input){commentEdge{node{url}}}}',
    variables: { input: { subjectId: 'PR_578', body: 'hello' } },
  },
};

const GH_JSON = { 'content-type': 'application/json; charset=utf-8', accept: '*/*', 'x-github-api-version': '2022-11-28', 'time-zone': 'Europe/Warsaw', 'user-agent': 'GitHub CLI 2.101.0', authorization: 'token gho_executor_has_none' };
const b64 = (value) => (value === undefined ? '' : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64'));

/// A request as gh sends it to api.github.com: `gh(method, path, body?)`.
export function gh(method, path, body) {
  return { host: 'api.github.com', method, path, headers: { ...GH_JSON }, body: b64(body) };
}

/// A GraphQL request as gh sends it.
export function ghql(doc) {
  return gh('POST', '/graphql', { query: doc.query, ...(doc.variables ? { variables: doc.variables } : {}) });
}

/// A request as glab sends it to the tests' GitLab host. glab names the project by its
/// URL-encoded path; `glab api projects/:id/...` uses the number it looked up first.
export function glab(method, path, body) {
  return {
    host: 'gitlab.example.com', method, path,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), 'private-token': 'glpat-executor-has-none', 'user-agent': 'glab/1.128.0' },
    body: b64(body),
  };
}

/// One smart-HTTP request of a git client pushing to `host`.
export function gitPush(host, path, body) {
  if (body === undefined) return { host, method: 'GET', path: `${path}/info/refs?service=git-receive-pack`, headers: { accept: '*/*', 'user-agent': 'git/2.39.5', 'git-protocol': 'version=2' }, body: '' };
  return { host, method: 'POST', path: `${path}/git-receive-pack`, headers: { 'content-type': 'application/x-git-receive-pack-request', accept: 'application/x-git-receive-pack-result', 'user-agent': 'git/2.39.5' }, body: body.toString('base64') };
}

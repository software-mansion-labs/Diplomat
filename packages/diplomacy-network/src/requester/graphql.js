// The GraphQL document check (PROTOCOL.md section 10). A GraphQL endpoint is one URL
// behind which the whole forge is reachable, so a rule on it says nothing until the
// document itself is read: which root fields it selects, which repository they name, and
// how far its selections walk from there.
//
// A forge's graph has no walls. From the pool's own repository a query can step to its
// owner, from the owner to every other repository the requester's token can see; from an
// issue to whatever cross-referenced it. A list of allowed root fields does not confine
// that, and there is no schema here to type-check against, so the reader tracks a
// CONTEXT instead - what kind of thing the selection is standing on - and every field that
// has a selection set must be one the context's table names, with the context it leads to:
//
//   in       the pool's repository and everything inside it; any scalar may be read
//   actor    a user, bot, team or organisation: a short list of scalars, and the account
//            or organisation it belongs to, reached without an argument
//   foreign  something that may live in another repository (a fork, a cross-referenced
//            issue, a project): a short list of identifying scalars
//   event    a timeline entry: its own scalars, its actors, and the things it points at as
//            `foreign`, because a "referenced" event's commit can sit in another repository
//   protection  a branch's protection rule: the one scalar the gh CLI reads of it
//   plain    scalars only
//   schema   type introspection, which the gh CLI runs before most commands
//
// The safety of `in` is an induction: a field mapped to `in` must return an object of the
// same repository on every type that can be reached in `in`. A field that breaks it on any
// such type is mapped to a stricter context, which over-restricts and is always safe. A
// scalar is told from an object by syntax: a field without a selection set that is really
// an object is a validation error at the forge and returns nothing.
//
// Fragments are resolved, not refused: every query the gh CLI sends uses them. Directives
// are parsed and ignored, so `@include(if: $x)` hides nothing. A field is known by its
// name; an alias is only a label on the response.

const MAX_SOURCE = 64 * 1024;
const MAX_TOKENS = 20000;
const MAX_DEPTH = 24;
const MAX_FIELDS = 5000;
const MAX_NODE_LOOKUPS = 8;

/// A document, body or request the check will not let through; `message` is the reason.
export class Refused extends Error {}
const refuse = (reason) => { throw new Refused(reason); };

// ---------------------------------------------------------------------------- lexer

const PUNCT = new Set(['!', '$', '&', '(', ')', ':', '=', '@', '[', ']', '{', '|', '}']);
const NAME_START = /[_A-Za-z]/;
const NAME_REST = /[_0-9A-Za-z]/;

function lex(src) {
  const tokens = [];
  let i = 0;
  const n = src.length;
  const push = (t) => {
    if (tokens.length >= MAX_TOKENS) refuse('graphql: document has too many tokens');
    tokens.push(t);
  };
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') { i++; continue; }
    if (c === '#') { while (i < n && src[i] !== '\n' && src[i] !== '\r') i++; continue; }
    if (c === '.') {
      if (src.startsWith('...', i)) { push({ t: 'punct', v: '...' }); i += 3; continue; }
      refuse('graphql: stray "."');
    }
    if (PUNCT.has(c)) { push({ t: 'punct', v: c }); i++; continue; }
    if (NAME_START.test(c)) {
      let j = i + 1;
      while (j < n && NAME_REST.test(src[j])) j++;
      push({ t: 'name', v: src.slice(i, j) });
      i = j;
      continue;
    }
    if (c === '-' || (c >= '0' && c <= '9')) {
      const m = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(src.slice(i, i + 64));
      if (!m) refuse('graphql: malformed number');
      const end = i + m[0].length;
      if (end < n && (NAME_REST.test(src[end]) || src[end] === '.')) refuse('graphql: malformed number');
      push(m[2] || m[3] ? { t: 'float', v: m[0] } : { t: 'int', v: m[0] });
      i = end;
      continue;
    }
    if (c === '"') {
      if (src.startsWith('"""', i)) {
        let j = i + 3;
        for (;;) {
          if (j >= n) refuse('graphql: unterminated block string');
          if (src.startsWith('\\"""', j)) { j += 4; continue; }
          if (src.startsWith('"""', j)) break;
          j++;
        }
        // The value of a block string depends on indentation rules this reader does not
        // carry; it is marked so that nothing ever compares it.
        push({ t: 'string', v: src.slice(i + 3, j), block: true });
        i = j + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      for (;;) {
        if (j >= n) refuse('graphql: unterminated string');
        const d = src[j];
        if (d === '"') break;
        if (d === '\n' || d === '\r') refuse('graphql: line break in a string');
        if (d !== '\\') { out += d; j++; continue; }
        const e = src[j + 1];
        const simple = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }[e];
        if (simple !== undefined) { out += simple; j += 2; continue; }
        if (e !== 'u') refuse('graphql: unknown escape in a string');
        let hex;
        if (src[j + 2] === '{') {
          const close = src.indexOf('}', j + 3);
          hex = close === -1 ? '' : src.slice(j + 3, close);
          j = close + 1;
        } else {
          hex = src.slice(j + 2, j + 6);
          j += 6;
        }
        if (!/^[0-9A-Fa-f]{1,6}$/.test(hex) || (src[j - 1] !== '}' && hex.length !== 4)) refuse('graphql: malformed unicode escape');
        const cp = parseInt(hex, 16);
        if (cp > 0x10ffff) refuse('graphql: malformed unicode escape');
        out += String.fromCodePoint(cp);
      }
      push({ t: 'string', v: out });
      i = j + 1;
      continue;
    }
    refuse(`graphql: unexpected character U+${c.codePointAt(0).toString(16).padStart(4, '0')}`);
  }
  push({ t: 'eof' });
  return tokens;
}

// --------------------------------------------------------------------------- parser

/// Parses an executable GraphQL document into `{ operations, fragments }`. Throws Refused
/// for anything that is not one: a syntax error, a type-system definition, a duplicate
/// name, or a document past the size and depth caps.
export function parseDocument(source) {
  if (typeof source !== 'string') refuse('graphql: the query is not a string');
  if (source.length > MAX_SOURCE) refuse('graphql: document is too large');
  const toks = lex(source);
  let p = 0;
  const peek = () => toks[p];
  const is = (v) => toks[p].t === 'punct' && toks[p].v === v;
  const isName = (v) => toks[p].t === 'name' && (v === undefined || toks[p].v === v);
  const eat = (v) => { if (!is(v)) refuse(`graphql: expected "${v}"`); p++; };
  const name = () => { if (toks[p].t !== 'name') refuse('graphql: expected a name'); return toks[p++].v; };

  function value(depth, constOnly) {
    if (depth > MAX_DEPTH) refuse('graphql: a value is nested too deeply');
    const t = peek();
    if (is('$')) {
      if (constOnly) refuse('graphql: a variable where a constant is required');
      p++;
      return { k: 'var', name: name() };
    }
    if (t.t === 'int') { p++; return { k: 'int', v: t.v }; }
    if (t.t === 'float') { p++; return { k: 'float', v: t.v }; }
    if (t.t === 'string') { p++; return { k: 'str', v: t.v, block: t.block === true }; }
    if (t.t === 'name') {
      p++;
      if (t.v === 'true' || t.v === 'false') return { k: 'bool', v: t.v === 'true' };
      if (t.v === 'null') return { k: 'null' };
      return { k: 'enum', v: t.v };
    }
    if (is('[')) {
      p++;
      const items = [];
      while (!is(']')) items.push(value(depth + 1, constOnly));
      p++;
      return { k: 'list', items };
    }
    if (is('{')) {
      p++;
      const fields = [];
      const seen = new Set();
      while (!is('}')) {
        const key = name();
        if (seen.has(key)) refuse(`graphql: input field "${key}" is given twice`);
        seen.add(key);
        eat(':');
        fields.push({ name: key, value: value(depth + 1, constOnly) });
      }
      p++;
      return { k: 'obj', fields };
    }
    return refuse('graphql: expected a value');
  }

  function args(constOnly) {
    const out = [];
    if (!is('(')) return out;
    p++;
    const seen = new Set();
    do {
      const key = name();
      if (seen.has(key)) refuse(`graphql: argument "${key}" is given twice`);
      seen.add(key);
      eat(':');
      out.push({ name: key, value: value(0, constOnly) });
    } while (!is(')'));
    p++;
    return out;
  }

  function directives(constOnly) {
    while (is('@')) { p++; name(); args(constOnly); }
  }

  function selectionSet(depth) {
    if (depth > MAX_DEPTH) refuse('graphql: selections are nested too deeply');
    eat('{');
    const out = [];
    do {
      if (is('...')) {
        p++;
        if (isName() && !isName('on')) {
          out.push({ kind: 'spread', name: name() });
          directives(false);
        } else {
          let on = null;
          if (isName('on')) { p++; on = name(); }
          directives(false);
          out.push({ kind: 'inline', on, selections: selectionSet(depth + 1) });
        }
        continue;
      }
      let fieldName = name();
      let alias = null;
      if (is(':')) { p++; alias = fieldName; fieldName = name(); }
      const fieldArgs = args(false);
      directives(false);
      out.push({ kind: 'field', alias, name: fieldName, args: fieldArgs, selections: is('{') ? selectionSet(depth + 1) : null });
    } while (!is('}'));
    p++;
    return out;
  }

  function type() {
    if (is('[')) { p++; type(); eat(']'); } else name();
    if (is('!')) p++;
  }

  const operations = [];
  const fragments = new Map();
  while (peek().t !== 'eof') {
    if (is('{')) {
      operations.push({ type: 'query', name: null, variables: new Map(), selections: selectionSet(1) });
      continue;
    }
    const word = name();
    if (word === 'fragment') {
      const fragName = name();
      if (fragName === 'on') refuse('graphql: a fragment cannot be named "on"');
      if (fragments.has(fragName)) refuse(`graphql: fragment "${fragName}" is defined twice`);
      if (!isName('on')) refuse('graphql: expected "on"');
      p++;
      const on = name();
      directives(true);
      fragments.set(fragName, { on, selections: selectionSet(1) });
      continue;
    }
    if (word !== 'query' && word !== 'mutation' && word !== 'subscription') refuse(`graphql: "${word}" is not an operation or a fragment`);
    const op = { type: word, name: isName() ? name() : null, variables: new Map(), selections: null };
    if (is('(')) {
      p++;
      do {
        eat('$');
        const varName = name();
        if (op.variables.has(varName)) refuse(`graphql: variable "$${varName}" is defined twice`);
        eat(':');
        type();
        let fallback;
        if (is('=')) { p++; fallback = value(0, true); }
        directives(true);
        op.variables.set(varName, { fallback });
      } while (!is(')'));
      p++;
    }
    directives(false);
    op.selections = selectionSet(1);
    operations.push(op);
  }
  return { operations, fragments };
}

// ----------------------------------------------------------------- argument values

// The JSON value an argument has once its variables are filled in, or undefined when a
// variable has neither a value nor a default. A block string becomes a marker object, so
// it can pass through as free text but never equals a pinned string.
function resolve(v, op, vars) {
  switch (v.k) {
    case 'var': {
      if (!op.variables.has(v.name)) refuse(`graphql: variable "$${v.name}" is not defined`);
      if (Object.hasOwn(vars, v.name)) return vars[v.name];
      const { fallback } = op.variables.get(v.name);
      return fallback === undefined ? undefined : resolve(fallback, op, vars);
    }
    case 'int': {
      const num = Number(v.v);
      if (!Number.isSafeInteger(num)) refuse('graphql: an integer out of range');
      return num;
    }
    case 'float': return Number(v.v);
    case 'str': return v.block ? { blockString: v.v } : v.v;
    case 'bool': return v.v;
    case 'null': return null;
    case 'enum': return v.v;
    case 'list': return v.items.map((item) => resolve(item, op, vars));
    default: {
      const out = Object.create(null);
      for (const f of v.fields) out[f.name] = resolve(f.value, op, vars);
      return out;
    }
  }
}

function argument(field, key, op, vars) {
  const found = field.args.find((a) => a.name === key);
  return found ? resolve(found.value, op, vars) : undefined;
}

// --------------------------------------------------------------------- the tables

const set = (words) => new Set(words.split(/\s+/).filter(Boolean));
function table(groups) {
  const out = new Map();
  for (const [context, words] of Object.entries(groups)) for (const w of set(words)) out.set(w, context);
  return out;
}

const WRAPPERS = { nodes: 'same', edges: 'same', node: 'same', pageInfo: 'plain' };
const SCHEMA_FIELDS = table({ schema: 'fields inputFields enumValues args type ofType possibleTypes interfaces' });

// A forge's tables. A field with a selection set leads from one context to the next (`repo`,
// `in`, `actor`, `foreign`, `event`, by the context it is selected in); `repo` is the pool's
// repository itself, from which a document goes on to its code, its pull requests and its
// issues, the twins of the reads rules.js gives every kind. A scalar is read from an
// allow-list on an account, a commit's author line, a foreign object and a branch's
// protection, and freely on what is in the pool's repository, but for `repoLeaves` and `own`:
//   repoLeaves  the scalars read of the repository itself: what the REST answer about it
//               holds (the repository `pick` of rules.js), under the names GraphQL has
//   own         the names not read inside the repository: they tell of the account asking -
//               what it may do there, its addresses, what it watches
//   blank       the names read and answered as null: a person's address
//   args        the arguments a field may take: paging, ordering and filters over what
//               the object it is selected on holds
//   members     the members an object given as an argument may hold, at any depth
//   ids         the arguments that name an object by its node id, which must turn out to
//               be in the pool's repository
// An argument or a member in no list could name another repository, or an object by an id
// nothing here can place, or filter by what the account asking watches or reacted to.
const FORGES = {
  github: {
    actorLeaves: set('__typename id databaseId login name url avatarUrl resourcePath date slug isViewer totalCount'),
    // The name, address and date a commit or a tag was written with: `gh pr view --json
    // commits` reads them.
    gitLeaves: set('name email date avatarUrl totalCount'),
    foreignLeaves: set(`__typename id databaseId number title url state stateReason name nameWithOwner isPrivate isFork isArchived
      isDraft closed optionId oid abbreviatedOid totalCount sshUrl description hasIssuesEnabled hasWikiEnabled viewerPermission`),
    // `viewerPermission` has no REST counterpart: `gh pr create` reads the account's
    // access level before it opens a pull request.
    repoLeaves: set(`id databaseId fullDatabaseId name nameWithOwner isPrivate visibility isFork isArchived isDisabled isTemplate
      url resourcePath sshUrl description descriptionHTML shortDescriptionHTML homepageUrl projectsUrl projectsResourcePath
      isInOrganization hasIssuesEnabled hasProjectsEnabled hasWikiEnabled hasDiscussionsEnabled createdAt updatedAt pushedAt
      diskUsage viewerPermission mergeCommitAllowed rebaseMergeAllowed squashMergeAllowed`),
    // `gh` reads which comments the account wrote.
    own: /viewer(?!DidAuthor$)/i,
    // The address of whoever enabled a pull request's auto-merge, which `gh pr view` reads.
    blank: set('authorEmail'),
    args: set(`after before first last orderBy orderByState direction states labels query filterBy number since until skip
      limit size baseRefName headRefName refName refPrefix qualifiedName name path expression oid author
      content itemTypes archivedStates includeArchived includeClosedPrs
      includeStack enableDuplicate excludeUserLinked userLinkedOnly mergeType pullRequestNumber writersOnly
      includeDeprecated`),
    members: set(`field direction assignee createdBy mentioned labels milestone milestoneNumber since states type
      issueFieldValues fieldName dateValue numberValue textValue singleSelectOptionValue multiSelectOptionValues
      appId checkName checkType conclusions status statuses emails`),
    ids: set('pullRequestId'),
    repo: table({
      in: `pullRequest pullRequests issue issues issueOrPullRequest ref refs defaultBranchRef object codeowners
        issueTemplates pullRequestTemplates contactLinks`,
      actor: 'owner',
      foreign: 'parent',
    }),
    in: table({
      in: `pullRequest pullRequests issue issues issueOrPullRequest ref refs defaultBranchRef baseRef target object
        tree entries blame ranges commit commits history parents file files comments reviews latestReviews
        latestOpinionatedReviews viewerLatestReview reviewThreads replyTo pullRequestReview originalCommit mergeCommit
        potentialMergeCommit statusCheckRollup contexts checkSuite checkSuites checkRuns workflowRun workflow status
        steps annotations location start end labels label milestone reactionGroups reactions userContentEdits
        autoMergeRequest reviewRequests suggestedReviewers subIssuesSummary signature mergeQueueEntry
        checkRunCountsByState statusContextCountsByState issueTemplates pullRequestTemplates codeowners contactLinks
        thread comment commentEdge subject assignable`,
      actor: `author editor owner mergedBy actor assignees assignedActors participants users reactors user creator
        pusher requestedReviewer reviewer enabledBy
        resolvedBy signer headRepositoryOwner onBehalfOf app`,
      // `author` is an account wherever else it is selected, so a commit's is read as one.
      git: 'authors committer tagger',
      // A pull request's head branch is a branch of the repository it comes from.
      foreign: `repository headRepository baseRepository headRef parent subIssues blockedBy blocking closingIssuesReferences
        closedByPullRequestsReferences associatedPullRequests projectItems projectCards trackedIssues trackedInIssues`,
      event: 'timelineItems',
      protection: 'branchProtectionRule',
      // An issue's type belongs to the repository's owner, and lists the issues of any
      // repository named to it: its own scalars are read and nothing is selected from it.
      plain: 'issueType',
    }),
    // `gh pr status` reads whether a pull request's base must be up to date before a
    // merge; the rest of a branch's protection is a setting no task has a use for.
    protectionLeaves: set('__typename requiresStrictStatusChecks'),
    actor: table({ actor: 'user organization' }),
    git: table({ actor: 'user' }),
    foreign: table({ actor: 'owner', foreign: 'repository project column fieldValueByName defaultBranchRef parent' }),
    // The one field with a selection set that takes an argument outside `in`: a project
    // item's own value of a named field.
    lookups: set('fieldValueByName'),
    event: table({
      actor: 'actor assignee author editor user requestedReviewer creator',
      foreign: `commit source subject target closer canonical duplicate ref review pullRequestCommit beforeCommit afterCommit
        label milestone deployment subIssue parent project fromRepository commitRepository pullRequest issue`,
    }),
  },
  gitlab: {
    actorLeaves: set('__typename id username name webUrl avatarUrl state bot'),
    foreignLeaves: set('__typename id iid title state name path fullPath webUrl reference visibility'),
    repoLeaves: set(`id name nameWithNamespace path fullPath description descriptionHtml visibility webUrl webPath sshUrlToRepo
      httpUrlToRepo topics tagList archived createdAt lastActivityAt issuesEnabled mergeRequestsEnabled jobsEnabled
      mergeRequestsFfOnlyEnabled squashReadOnly removeSourceBranchAfterMerge onlyAllowMergeIfPipelineSucceeds
      onlyAllowMergeIfAllDiscussionsAreResolved`),
    // What the account may do with a blob, a job or a pipeline, whether it is subscribed,
    // and the address its replies to an issue go to.
    own: /^can[A-Z]|^(createNoteEmail|subscribed|troubleshootJobWithAi)$/,
    // The address of the person who wrote an issue or a note in through the Service Desk.
    blank: set('externalAuthor'),
    args: set(`after before first last limit offset sort order state status statuses types jobKind
      iid iids ref refType path paths blobPath recursive full format firstParent search in
      searchPattern query filter not or customField labelName labels milestoneTitle
      milestoneWildcardId releaseTag releaseTagWildcardId author authorUsername assigneeUsername
      assigneeUsernames assigneeWildcardId reviewerUsername reviewerWildcardId ignoredReviewerUsername reviewState
      reviewStates approvedBy approver mergedBy confidential draft retried
      whenExecuted securityReportTypes environmentName sourceBranches targetBranches weight
      weightWildcardId healthStatus healthStatusFilter epicWildcardId includeSubepics iterationTitle iterationWildcardId
      createdAfter createdBefore updatedAfter updatedBefore closedAfter closedBefore mergedAfter mergedBefore
      deployedAfter deployedBefore committedAfter committedBefore dueAfter dueBefore`),
    members: set(`approvedBy assigneeUsernames authorUsername authorUsernames labelName labelNames labels milestoneTitle
      milestoneWildcardId releaseTag reviewStates reviewerUsername reviewerWildcard onlyReviewer onlyReviewerUsername
      sourceBranches targetBranches iids types weight iterationWildcardId healthStatusFilter customField
      customFieldName selectedOptionValues name`),
    ids: set(''),
    repo: table({ in: 'mergeRequest mergeRequests issue issues repository', foreign: 'group namespace' }),
    in: table({
      in: `mergeRequest discussions discussion notes position diffRefs diffStats diffStatsSummary
        commits commitsWithoutMergeCommits headPipeline jobs stages detailedStatus labels
        tree trees blobs lastCommit taskCompletionStatus approvalState rules`,
      actor: `author assignees reviewers user resolvedBy approvedBy mergeUser participants commenters updatedBy lastEditedBy
        eligibleApprovers`,
      foreign: 'project sourceProject targetProject relatedMergeRequests closingMergeRequests',
      // A milestone may be a group's, with the releases of the group's other projects under it.
      plain: 'milestone',
    }),
    actor: table({}),
    foreign: table({ foreign: 'namespace group' }),
    lookups: set(''),
  },
};

// ------------------------------------------------------------------ search queries

const OWNER_QUALIFIER = /^-?(repo|org|user|owner|enterprise):/i;

// One term of a search string, from where the last one ended: a bare word, or a phrase in
// quotes that stands as a term of its own or as the value of one qualifier
// (`label:"good first issue"`), with any parentheses around it.
const SEARCH_TERM = /\s*(?:(\(*)(-?(?:[\w.-]+:)?)"([^"\\]*)"(\)*)|([^\s"]+))(?=\s|$)/y;

/// Whether a forge search string can only return things in `repo` ("owner/name"): it must
/// carry `repo:owner/name` as a plain term of its own, the qualifier in lower case and the
/// name in any, and nothing that widens it - no
/// other repository, organisation or user qualifier, no top-level OR, no negation of the
/// term. A quote may only wrap a whole term or a qualifier's whole value, and what it
/// wraps holds no qualifier: where a quote opens mid-word, this reader and the forge's
/// need not agree on where the phrase ends, and a qualifier could hide in the difference.
/// Returns null when confined, else the reason.
export function searchConfined(q, repo) {
  if (typeof q !== 'string') return 'the search query is not a string';
  // Terms are told apart by the plain space alone: any other separator is one the forge
  // may or may not split on.
  if (/[\u0000-\u001f\u007f-\u009f]|[^\S ]/.test(q)) return 'the search query holds a control character or a space that is not the plain one';
  const want = `repo:${repo}`.toLowerCase();
  let depth = 0;
  let pinned = 0;
  let previous = '';
  for (let at = 0; q.slice(at).trim() !== '';) {
    SEARCH_TERM.lastIndex = at;
    const m = SEARCH_TERM.exec(q);
    if (!m) return 'the search query has a quote that is not a whole quoted term';
    at = SEARCH_TERM.lastIndex;
    // A qualifier with a quoted value keeps its prefix, so `repo:"a/b"` is seen as a
    // repo qualifier and never equals the pin.
    let term = m[5] ?? m[2];
    let closing = 0;
    if (m[5] === undefined) {
      if (/[\w-]:/.test(m[3])) return 'the search query has a quoted term that holds a qualifier';
      depth += m[1].length;
      closing = m[4].length;
      previous = '"';
    } else {
      while (term.startsWith('(')) { depth++; term = term.slice(1); }
      while (term.endsWith(')')) { closing++; term = term.slice(0, -1); }
    }
    if (term.includes('(') || term.includes(')')) return 'the search query has parentheses inside a term';
    if (term !== '') {
      const upper = term.toUpperCase();
      if (upper === 'OR' && depth === 0) return 'the search query has a top-level OR';
      if (OWNER_QUALIFIER.test(term)) {
        const negated = previous.toUpperCase() === 'NOT';
        if (term.toLowerCase() !== want || depth !== 0 || negated) return 'the search query names something other than the pool\'s repository';
        // In another case the forge may read it as the qualifier or as a word; `gh` writes this one.
        if (!term.startsWith('repo:')) return 'the search query does not write the qualifier of the pool\'s repository as "repo:"';
        pinned++;
      }
      previous = term;
    }
    depth -= closing;
    if (depth < 0) return 'the search query has unbalanced parentheses';
  }
  if (depth !== 0) return 'the search query has unbalanced parentheses';
  if (pinned !== 1) return 'the search query is not pinned to the pool\'s repository';
  return null;
}

// ------------------------------------------------------------------------ queries

const UNLISTED = 'which could name something outside the pool\'s repository or tell of the account asking';

// `lookups` takes the node ids the document's arguments name, for the caller to resolve.
function walker(doc, forge, op, vars, lookups) {
  const tables = FORGES[forge];
  const done = new Set(); // "fragment name/context": a fragment is read once per context
  const blanks = new Set(); // the answer's names for the `blank` fields selected
  let fields = 0;

  // A variable stands for what is sent for it, else for its default.
  function checkMembers(sel, arg, value) {
    const listed = (name) => { if (!tables.members.has(name)) refuse(`graphql: "${sel.name}" may not be given "${name}" inside "${arg}", ${UNLISTED}`); };
    const sent = (json) => {
      if (Array.isArray(json)) json.forEach(sent);
      else if (json !== null && typeof json === 'object') for (const [name, inner] of Object.entries(json)) { listed(name); sent(inner); }
    };
    const written = (v) => {
      if (v.k === 'list') v.items.forEach(written);
      else if (v.k === 'obj') for (const f of v.fields) { listed(f.name); written(f.value); }
      else if (v.k === 'var') {
        if (!op.variables.has(v.name)) refuse(`graphql: variable "$${v.name}" is not defined`);
        if (Object.hasOwn(vars, v.name)) sent(vars[v.name]);
        else if (op.variables.get(v.name).fallback) written(op.variables.get(v.name).fallback);
      }
    };
    written(value);
  }

  function checkArguments(sel) {
    for (const { name, value } of sel.args) {
      if (!tables.ids.has(name)) {
        if (!tables.args.has(name)) refuse(`graphql: "${sel.name}" may not be given "${name}", ${UNLISTED}`);
        checkMembers(sel, name, value);
        continue;
      }
      const id = argument(sel, name, op, vars);
      if (id === null || id === undefined) continue;
      if (typeof id !== 'string' || id === '') refuse(`graphql: "${name}" is not a node id`);
      lookups.push({ id, need: { inRepo: true }, what: `"${sel.name}(${name}:)"` });
    }
  }

  function walk(selections, context, depth, active) {
    if (depth > MAX_DEPTH) refuse('graphql: selections are nested too deeply');
    for (const sel of selections) {
      if (sel.kind === 'inline') { walk(sel.selections, context, depth + 1, active); continue; }
      if (sel.kind === 'spread') {
        const frag = doc.fragments.get(sel.name);
        if (!frag) refuse(`graphql: fragment "${sel.name}" is not defined`);
        if (active.has(sel.name)) refuse(`graphql: fragment "${sel.name}" spreads itself`);
        const key = `${sel.name}/${context}`;
        if (done.has(key)) continue;
        done.add(key);
        walk(frag.selections, context, depth + 1, new Set(active).add(sel.name));
        continue;
      }
      if (++fields > MAX_FIELDS) refuse('graphql: document selects too many fields');
      if (sel.selections === null) {
        if (sel.name === '__typename') continue;
        if (context === 'actor' && !tables.actorLeaves.has(sel.name)) refuse(`graphql: "${sel.name}" may not be read on a user or organisation`);
        if (context === 'git' && !tables.gitLeaves.has(sel.name)) refuse(`graphql: "${sel.name}" may not be read of a commit's author line`);
        if (context === 'foreign' && !tables.foreignLeaves.has(sel.name)) refuse(`graphql: "${sel.name}" may not be read on an object outside the pool's repository`);
        if (context === 'protection' && !tables.protectionLeaves.has(sel.name)) refuse(`graphql: "${sel.name}" may not be read of a branch's protection`);
        if (context === 'repo' && !tables.repoLeaves.has(sel.name)) refuse(`graphql: "${sel.name}" is not among what a task is told of the repository itself`);
        if ((context === 'in' || context === 'event' || context === 'plain') && tables.own.test(sel.name)) refuse(`graphql: "${sel.name}" tells of the account asking, not of the repository`);
        if (tables.blank.has(sel.name)) blanks.add(sel.alias ?? sel.name);
        checkArguments(sel);
        continue;
      }
      const wrapper = WRAPPERS[sel.name];
      let next = wrapper === 'same' ? context : wrapper;
      if (context === 'schema') next = SCHEMA_FIELDS.get(sel.name);
      else if (context === 'plain') next = undefined;
      else if (next === undefined) next = tables[context]?.get(sel.name);
      if (next === undefined) refuse(`graphql: "${sel.name}" is not a field this task may select into here`);
      // An argument on a field of an account or of a foreign object is a lookup from it:
      // `organization(login:)` on a user reaches any organisation the token can see.
      if ((context === 'actor' || context === 'foreign') && sel.args.length > 0 && !tables.lookups.has(sel.name)) {
        refuse(`graphql: "${sel.name}" takes arguments here, which would look another object up`);
      }
      checkArguments(sel);
      walk(sel.selections, next, depth + 1, active);
    }
  }

  // The fields a selection set selects once fragments are inlined; used at the root.
  function flatten(selections, out, active, depth) {
    if (depth > MAX_DEPTH) refuse('graphql: selections are nested too deeply');
    for (const sel of selections) {
      if (sel.kind === 'field') { out.push(sel); continue; }
      if (sel.kind === 'inline') { flatten(sel.selections, out, active, depth + 1); continue; }
      const frag = doc.fragments.get(sel.name);
      if (!frag) refuse(`graphql: fragment "${sel.name}" is not defined`);
      if (active.has(sel.name)) refuse(`graphql: fragment "${sel.name}" spreads itself`);
      flatten(frag.selections, out, new Set(active).add(sel.name), depth + 1);
    }
    if (out.length > MAX_FIELDS) refuse('graphql: document selects too many fields');
    return out;
  }

  return { walk, flatten, blanks };
}

const SEARCH_TYPES = new Set(['ISSUE', 'ISSUE_ADVANCED']);
const sameRepo = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

// Returns the answer's names for the `blank` fields the query selects.
function checkQuery(doc, op, vars, spec, lookups) {
  const { walk, flatten, blanks } = walker(doc, spec.forge, op, vars, lookups);
  const roots = new Set(spec.roots || []);
  const [owner, repoName] = spec.forge === 'github' ? spec.repo.split('/') : [];
  for (const field of flatten(op.selections, [], new Set(), 1)) {
    if (field.name === '__typename' && field.selections === null) continue;
    if (!roots.has(field.name)) refuse(`graphql: root field "${field.name}" is not allowed for this task`);
    if (field.selections === null) refuse(`graphql: root field "${field.name}" selects nothing`);
    switch (field.name) {
      case 'repository': {
        if (spec.forge !== 'github') refuse('graphql: root field "repository" is not allowed for this task');
        if (!sameRepo(argument(field, 'owner', op, vars), owner) || !sameRepo(argument(field, 'name', op, vars), repoName)) {
          refuse('graphql: "repository" does not name the pool\'s repository');
        }
        walk(field.selections, 'repo', 2, new Set());
        break;
      }
      case 'project': {
        if (spec.forge !== 'gitlab') refuse('graphql: root field "project" is not allowed for this task');
        if (!sameRepo(argument(field, 'fullPath', op, vars), spec.repo)) refuse('graphql: "project" does not name the pool\'s project');
        walk(field.selections, 'repo', 2, new Set());
        break;
      }
      case 'viewer':
      case 'currentUser':
        walk(field.selections, 'actor', 2, new Set());
        break;
      case 'rateLimit':
        walk(field.selections, 'plain', 2, new Set());
        break;
      case '__type':
        walk(field.selections, 'schema', 2, new Set());
        break;
      case 'search': {
        if (spec.forge !== 'github') refuse('graphql: root field "search" is not allowed for this task');
        const why = searchConfined(argument(field, 'query', op, vars), spec.repo);
        if (why) refuse(`graphql: ${why}`);
        if (!SEARCH_TYPES.has(argument(field, 'type', op, vars))) refuse('graphql: "search" may only search issues and pull requests');
        walk(field.selections, 'in', 2, new Set());
        break;
      }
      case 'node': {
        if (spec.forge !== 'github') refuse('graphql: root field "node" is not allowed for this task');
        const id = argument(field, 'id', op, vars);
        if (typeof id !== 'string' || id === '') refuse('graphql: "node" needs a literal id');
        // The id may be the repository's own, of which less is told than of what is in it.
        let ofRepository;
        try {
          walker(doc, spec.forge, op, vars, []).walk(field.selections, 'repo', 2, new Set());
        } catch (err) {
          if (!(err instanceof Refused)) throw err;
          ofRepository = err.message;
        }
        lookups.push({ id, need: { inRepo: true, ofRepository }, what: '"node"' });
        walk(field.selections, 'in', 2, new Set());
        break;
      }
      default:
        refuse(`graphql: root field "${field.name}" cannot be confined to the pool's repository`);
    }
  }
  return blanks;
}

// ---------------------------------------------------------------------- mutations

// What a forge or a bot on it takes for a command: a line that starts with "/" and a word
// of letters, "_" and "-" before white space or the end (GitLab's quick actions, Prow's
// "/approve"), and anywhere in the text an account named with "@" or the word "bors" -
// homu acts on any line naming it, claude-code-action on "@claude" anywhere, Copilot on
// "@copilot" in any comment. Bots read the text as it was sent, so no markdown hides one.
// Text posted in the requester's name is otherwise a way to do anything such a command
// can, and a task has no one to call on.
const COMMAND = /(^|[\r\n\v\f\u0085\u2028\u2029])[ \t]*\/[a-z][a-z_-]*(?=\s|$)|@[\p{L}\p{N}_.-]|\bbors\b/iu;
const REWORD = 'text in the requester\'s name names no account with "@" anywhere in it, code included (write "the Override annotation", '
  + '"types/node", no e-mail address), says no "bors" and starts no line with "/" and a word; reword it and send the request again';
/// Why `text` may not be written in the requester's name - what in it a forge or a bot
/// would take for a command, quoted, and how to reword it - or null when it may.
export function proseFault(text) {
  if (typeof text !== 'string') return 'is not text';
  const found = COMMAND.exec(text);
  if (!found) return null;
  const said = text.slice(found.index + (found[1] ?? '').length).trimStart().match(/^\S{1,40}/)[0];
  return `holds ${JSON.stringify(said)}, which the forge or a bot on it would take for a command: ${REWORD}`;
}
const PROSE = { prose: true };

// What each mutation's `input` may hold. A key the table does not name is refused, so a
// field that changes what the mutation does (an `event`, a second target) cannot ride
// along. `node` values are opaque ids the forge is asked about before anything is sent:
//   item      the object belongs to the task's own pull request or issue
//   own       it was written by the identity the task acts as
//   pending   it is part of a review that has not been submitted
//   repo      it is the pool's repository
// `free` is text or layout the task decides, `prose` text that has no `proseFault`. `created` is a branch the task created,
// from which it has opened no pull request: "branch", or "account:branch" for one in
// that account's fork.
// `assignees` is the issue's whole new assignee list, which may differ from the list the
// forge holds only by the task's own account.
const THREAD = ['PullRequestReviewThread'];
const REVIEW = ['PullRequestReview'];
const MUTATIONS = {
  github: {
    addPullRequestReviewThread: {
      pullRequestReviewId: { node: REVIEW, item: 'pr', own: true, pending: true, required: true },
      path: 'free', line: 'free', side: 'free', startLine: 'free', startSide: 'free', body: PROSE, subjectType: 'free',
      clientMutationId: 'free',
    },
    addPullRequestReviewThreadReply: {
      pullRequestReviewThreadId: { node: THREAD, item: 'pr', required: true },
      pullRequestReviewId: { node: REVIEW, item: 'pr', own: true, pending: true },
      body: PROSE, clientMutationId: 'free',
    },
    deletePullRequestReviewComment: {
      id: { node: ['PullRequestReviewComment'], item: 'pr', own: true, pending: true, required: true },
      clientMutationId: 'free',
    },
    resolveReviewThread: {
      threadId: { node: THREAD, item: 'pr', required: true },
      clientMutationId: 'free',
    },
    markPullRequestReadyForReview: {
      pullRequestId: { node: ['PullRequest'], item: 'pr', required: true },
      clientMutationId: 'free',
    },
    addComment: {
      subjectId: { node: ['Issue'], item: 'issue', required: true },
      body: PROSE, clientMutationId: 'free',
    },
    replaceActorsForAssignable: {
      assignableId: { node: ['Issue'], item: 'issue', required: true },
      actorLogins: { assignees: true, required: true },
      clientMutationId: 'free',
    },
    // The gh CLI ends `gh issue edit` with an update that names the issue and changes
    // nothing; the id is the only input it may carry.
    updateIssue: {
      id: { node: ['Issue'], item: 'issue', required: true },
      clientMutationId: 'free',
    },
    createPullRequest: {
      repositoryId: { node: ['Repository'], repo: true, required: true },
      headRefName: { created: true, required: true },
      draft: { equals: true, required: true },
      baseRefName: 'free', title: PROSE, body: PROSE, maintainerCanModify: 'free', clientMutationId: 'free',
    },
  },
  gitlab: {},
};

/// The mutation names the check knows how to confine on a forge; the catalogue may list
/// no others.
export function knownMutations(forge) {
  return Object.keys(MUTATIONS[forge] || {});
}

function checkMutation(doc, op, vars, spec, lookups, effects) {
  const { walk, flatten, blanks } = walker(doc, spec.forge, op, vars, lookups);
  const fields = flatten(op.selections, [], new Set(), 1);
  if (fields.length !== 1) refuse('graphql: a mutation must be exactly one field');
  const [field] = fields;
  const shape = MUTATIONS[spec.forge][field.name];
  if (!(spec.mutations || []).includes(field.name) || !shape) refuse(`graphql: mutation "${field.name}" is not allowed for this task`);
  if (field.args.length !== 1 || field.args[0].name !== 'input') refuse('graphql: a mutation takes one argument, "input"');
  const input = argument(field, 'input', op, vars);
  if (input === null || typeof input !== 'object' || Array.isArray(input)) refuse('graphql: the mutation\'s input is not an object');
  for (const [key, val] of Object.entries(input)) {
    const rule = Object.hasOwn(shape, key) ? shape[key] : undefined;
    if (rule === undefined) refuse(`graphql: "${key}" is not an input this task may give ${field.name}`);
    if (rule === 'free') continue;
    if (val === null || val === undefined) {
      if (rule.required) refuse(`graphql: ${field.name} needs "${key}"`);
      continue;
    }
    if (rule.node) {
      if (typeof val !== 'string' || val === '') refuse(`graphql: "${key}" is not a node id`);
      lookups.push({ id: val, need: rule, what: `${field.name}.${key}` });
    } else if (rule.assignees) {
      if (!Array.isArray(val) || val.some((l) => typeof l !== 'string')) refuse(`graphql: "${key}" is not a list of logins`);
      lookups.push({ logins: val, what: `${field.name}.${key}` });
    } else if (rule.created) {
      if (typeof val !== 'string') refuse(`graphql: "${key}" is not a branch name`);
      effects.push({ head: val });
    } else if (rule.prose) {
      const fault = proseFault(typeof val === 'object' ? val.blockString : val);
      if (fault) refuse(`graphql: "${key}" ${fault}`);
    } else if (val !== rule.equals) {
      refuse(`graphql: ${field.name} needs "${key}" to be ${JSON.stringify(rule.equals)}`);
    }
  }
  for (const [key, rule] of Object.entries(shape)) {
    if (rule !== 'free' && rule.required && (input[key] === undefined || input[key] === null)) refuse(`graphql: ${field.name} needs "${key}"`);
  }
  // The payload is a read like any other: it starts on the object the mutation touched.
  if (field.selections) walk(field.selections, 'in', 2, new Set());
  return blanks;
}

/// Whether a resolved node belongs to the task's item: `item` is `{ type: 'pr'|'issue',
/// number }` for one pull request or issue, or `{ type, author?, notAuthor? }` for every
/// open one written (or not written) by a login. Returns null when it does, else the reason.
export function itemMismatch(item, node) {
  if (!item) return 'this task has no pull request or issue of its own';
  if (node.item !== item.type) return `it is not part of ${item.type === 'pr' ? 'a pull request' : 'an issue'}`;
  if (item.number !== undefined) return node.number === item.number ? null : `it belongs to #${node.number}, not #${item.number}`;
  if (node.open !== true) return `#${node.number} is not open`;
  const author = String(node.itemAuthor || '').toLowerCase();
  if (item.author !== undefined && author !== item.author) return `#${node.number} was not opened by ${item.author}`;
  if (item.notAuthor !== undefined && author === item.notAuthor) return `#${node.number} was opened by ${item.notAuthor}`;
  return null;
}

/// Whether an issue's new assignee list holds the same accounts as the one the forge
/// holds, `self` aside. The lists are logins or account ids: a login's case and an
/// account named twice change nothing.
export function sameButSelf(held, wanted, self) {
  const key = (account) => String(account).toLowerCase();
  const others = (list) => JSON.stringify([...new Set(list.map(key))].filter((account) => account !== key(self)).sort());
  return others(held) === others(wanted);
}

async function settle(lookups, spec, ctx) {
  if (lookups.length > MAX_NODE_LOOKUPS) refuse('graphql: the document addresses too many objects');
  if (lookups.some((l) => l.id !== undefined) && typeof ctx.resolveNode !== 'function') refuse('graphql: nothing here can resolve a node id');
  const resolved = new Map();
  for (const { id, logins, need, what } of lookups) {
    if (logins) {
      if (spec.item?.type !== 'issue' || spec.item.number === undefined || typeof ctx.assignees !== 'function') refuse(`graphql: ${what}: this task has no issue to assign`);
      const now = await ctx.assignees(spec.item.number);
      if (!now) refuse(`graphql: ${what}: #${spec.item.number} is not an issue the forge would show`);
      if (!sameButSelf(now, logins, spec.identity)) refuse(`graphql: ${what} may only add or remove this task's own account`);
      continue;
    }
    // `gh pr checks` names its pull request three times over.
    if (!resolved.has(id)) resolved.set(id, await ctx.resolveNode(id));
    const node = resolved.get(id);
    if (!node) refuse(`graphql: ${what} is not an object the forge would show`);
    if (!sameRepo(node.repo, spec.repo)) refuse(`graphql: ${what} is not in the pool's repository`);
    if (need.inRepo || need.repo) {
      if (need.repo && node.type !== 'Repository') refuse(`graphql: ${what} is not a repository`);
      if (need.ofRepository !== undefined && node.type === 'Repository') refuse(need.ofRepository);
      continue;
    }
    if (!need.node.includes(node.type)) refuse(`graphql: ${what} is a ${node.type}`);
    const why = itemMismatch(spec.item, node);
    if (why) refuse(`graphql: ${what}: ${why}`);
    if (need.own && !sameRepo(node.author, spec.identity)) refuse(`graphql: ${what} was not written by this task's account`);
    if (need.pending && node.pending !== true) refuse(`graphql: ${what} is not part of a pending review`);
  }
}

/// Checks one GraphQL request body against a rule's `graphql` member: `spec` is `{ forge,
/// repo, roots, mutations, item, identity }` and `payload` the parsed JSON body. Resolves
/// to `{ ok: true, effects, blank? }` - `effects` lists what the request would use up, such
/// as a pull request opened from a pushed branch, and `blank` the names of the answer's
/// members to hand back as null - or `{ ok: false, reason }`. Node ids are
/// resolved through `ctx.resolveNode(id)` before the answer is given.
export async function checkGraphql(spec, payload, ctx = {}) {
  try {
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) refuse('graphql: the body is not one request object');
    for (const key of Object.keys(payload)) {
      if (key !== 'query' && key !== 'variables' && key !== 'operationName') refuse(`graphql: the body has an unknown member "${key}"`);
    }
    const vars = payload.variables ?? {};
    if (typeof vars !== 'object' || Array.isArray(vars)) refuse('graphql: variables is not an object');
    if (payload.operationName !== undefined && payload.operationName !== null && typeof payload.operationName !== 'string') refuse('graphql: operationName is not a string');
    if (!FORGES[spec.forge]) refuse('graphql: unknown forge');
    const doc = parseDocument(payload.query);
    if (doc.operations.length !== 1) refuse(doc.operations.length === 0 ? 'graphql: the document has no operation' : 'graphql: the document has more than one operation');
    const [op] = doc.operations;
    const lookups = [];
    const effects = [];
    if (op.type === 'subscription') refuse('graphql: subscriptions are not allowed');
    const blanks = op.type === 'query' ? checkQuery(doc, op, vars, spec, lookups) : checkMutation(doc, op, vars, spec, lookups, effects);
    await settle(lookups, spec, ctx);
    return { ok: true, effects, ...(blanks.size > 0 ? { blank: [...blanks] } : {}) };
  } catch (err) {
    if (err instanceof Refused) return { ok: false, reason: err.message };
    throw err;
  }
}

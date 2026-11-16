// What the two forges' published GraphQL schemas say of the types a task's document can
// reach inside the pool's repository: the facts the document check's tables are held to.
// Written from the schemas named in `source` by walking them from the repository type
// along the tables of src/requester/graphql.js; a field name added to those tables calls
// for the walk to be made again.

const words = (text) => text.split(/\s+/).filter(Boolean);

/// Per forge:
///   repository        the type of the pool's repository itself
///   repositoryLeaves  every scalar field of that type
///   accountLeaves     the scalar fields of the other reachable types that are named for
///                     the viewer, or described as being about the viewer or the current user
///   arguments         every argument of every field the tables accept on a reachable
///                     type, with each type it is declared with and one field that takes
///                     it: "name:Type@Type.field"
export const SCHEMA = {
  github: {
    source: 'https://docs.github.com/public/fpt/schema.docs.graphql of 2026-11-16, sha256 d928ebbb2d08cba348c0c5713ab3c8756a39e838324089ff66fcddf1bab2c496',
    repository: 'Repository',
    repositoryLeaves: words(`
      allowUpdateBranch archivedAt autoMergeAllowed createdAt databaseId deleteBranchOnMerge description
      descriptionHTML diskUsage forkCount forkingAllowed fullDatabaseId hasDiscussionsEnabled hasIssuesEnabled
      hasProjectsEnabled hasPullRequestsEnabled hasSponsorshipsEnabled hasVulnerabilityAlertsEnabled
      hasWikiEnabled homepageUrl id isArchived isBlankIssuesEnabled isDisabled isEmpty isFork isInOrganization
      isLocked isMirror isPrivate isSecurityPolicyEnabled isTemplate isUserConfigurationRepository
      issueCreationPolicy lockReason mergeCommitAllowed mergeCommitMessage mergeCommitTitle mirrorUrl name
      nameWithOwner openGraphImageUrl projectsResourcePath projectsUrl pullRequestCreationPolicy pushedAt
      rebaseMergeAllowed resourcePath securityPolicyUrl shortDescriptionHTML squashMergeAllowed
      squashMergeCommitMessage squashMergeCommitTitle squashPrTitleUsedAsDefault sshUrl stargazerCount
      tempCloneToken updatedAt url usesCustomOpenGraphImage viewerCanAdminister viewerCanCreateIssues
      viewerCanCreateProjects viewerCanSeeIssueFields viewerCanSubscribe viewerCanUpdateTopics
      viewerDefaultCommitEmail viewerDefaultMergeMethod viewerHasStarred viewerPermission
      viewerPossibleCommitEmails viewerSubscription visibility webCommitSignoffRequired`),
    accountLeaves: words(`
      isReadByViewer viewerCanApplySuggestion viewerCanAssign viewerCanClose viewerCanDelete
      viewerCanDeleteHeadRef viewerCanDisableAutoMerge viewerCanEditFiles viewerCanEnableAutoMerge
      viewerCanLabel viewerCanMarkAsAnswer viewerCanMergeAsAdmin viewerCanMinimize viewerCanPin
      viewerCanPushRepository viewerCanReact viewerCanReadRepository viewerCanReopen viewerCanReply
      viewerCanResolve viewerCanSetFields viewerCanSetMilestone viewerCanSetStatus viewerCanSubscribe
      viewerCanType viewerCanUnmarkAsAnswer viewerCanUnminimize viewerCanUnpin viewerCanUnresolve
      viewerCanUpdate viewerCanUpdateBranch viewerCanUpdateMetadata viewerCanUpvote viewerCannotUpdateReasons
      viewerDidAuthor viewerHasReacted viewerHasUpvoted viewerMergeBodyText viewerMergeHeadlineText
      viewerSubscription viewerThreadSubscriptionFormAction viewerThreadSubscriptionStatus viewerViewedState`),
    arguments: words(`
      after:String@CheckRun.annotations archivedStates:ProjectCardArchivedState@Issue.projectCards
      author:CommitAuthor@Commit.history author:String@PullRequest.reviews
      baseRefName:String@Label.pullRequests before:String@CheckRun.annotations
      capabilities:RepositorySuggestedActorFilter@Repository.suggestedActors
      content:ReactionContent@CommitComment.reactions direction:OrderDirection@Repository.refs
      enableDuplicate:Boolean@Issue.stateReason excludeUserLinked:Boolean@Issue.closedByPullRequestsReferences
      expression:String@Repository.object filterBy:CheckRunFilter@CheckSuite.checkRuns
      filterBy:CheckSuiteFilter@Commit.checkSuites filterBy:IssueFilters@Label.issues
      first:Int@CheckRun.annotations headRefName:String@Label.pullRequests
      includeArchived:Boolean@Issue.projectItems includeClosedPrs:Boolean@Issue.closedByPullRequestsReferences
      includeStack:Boolean@PullRequest.autoMergeRequest
      itemTypes:IssueTimelineItemsItemType@Issue.timelineItems
      itemTypes:PullRequestTimelineItemsItemType@PullRequest.timelineItems labels:String@Label.issues
      last:Int@CheckRun.annotations limit:Int@Release.shortDescriptionHTML
      loginNames:String@Repository.suggestedActors
      mergeType:PullRequestMergeMethod@PullRequest.viewerMergeBodyText
      name:String@ProjectV2Item.fieldValueByName number:Int@CheckRun.steps oid:GitObjectID@Repository.object
      orderBy:IssueCommentOrder@Issue.comments orderBy:IssueDependencyOrder@Issue.blockedBy
      orderBy:IssueOrder@Label.issues orderBy:LabelOrder@Discussion.labels
      orderBy:LanguageOrder@Repository.languages orderBy:MilestoneOrder@Repository.milestones
      orderBy:PullRequestOrder@Commit.associatedPullRequests orderBy:ReactionOrder@CommitComment.reactions
      orderBy:RefOrder@Repository.refs orderBy:ReleaseOrder@Repository.releases
      orderBy:WorkflowRunOrder@Workflow.runs orderByState:Boolean@Issue.closedByPullRequestsReferences
      path:String@Commit.blame pullRequestId:ID@CheckRun.isRequired pullRequestNumber:Int@CheckRun.isRequired
      qualifiedName:String@Repository.ref query:String@Issue.suggestedActors
      refName:String@Repository.codeowners refPrefix:String@Repository.refs since:DateTime@Issue.timelineItems
      since:GitTimestamp@Commit.history size:Int@Bot.avatarUrl skip:Int@Issue.timelineItems
      states:IssueState@Label.issues states:MilestoneState@Repository.milestones
      states:PullRequestReviewState@PullRequest.reviews states:PullRequestState@Label.pullRequests
      states:TrackedIssueStates@Issue.trackedIssuesCount tagName:String@Repository.release
      until:GitTimestamp@Commit.history userLinkedOnly:Boolean@Issue.closedByPullRequestsReferences
      writersOnly:Boolean@PullRequest.latestOpinionatedReviews`),
  },
  gitlab: {
    source: 'https://gitlab.com/-/graphql/introspection_result.json of 2026-11-16, sha256 e21c0306e95ff467e606d7cfb1652534900269ab7ec4f8fddace5d894bf718a6',
    repository: 'Project',
    repositoryLeaves: words(`
      actualRepositorySizeLimit adminEditPath adminShowPath allowMergeOnSkippedPipeline
      allowsMultipleMergeRequestAssignees allowsMultipleMergeRequestReviewers archived
      autocloseReferencedIssues avatarUrl ciConfigPathOrDefault containerRegistryEnabled
      containerRepositoriesCount containerScanningForRegistryEnabled createdAt description descriptionHtml
      duoAgenticChatAvailable duoDependencyBumpBreakingChangesAvailable duoFeaturesEnabled duoMcpServerNames
      duoMcpServersCount duoWorkflowRunnerAvailable duoWorkflowUsableRunnerType editPath exploreCatalogPath
      forksCount fullPath hasJiraVulnerabilityIssueCreationEnabled httpUrlToRepo id importStatus
      isCatalogResource isForked isPublished isSelfArchived isSelfDeletionInProgress isSelfDeletionScheduled
      issuesEnabled jiraImportStatus jobsEnabled lastActivityAt lfsEnabled markedForDeletion
      markedForDeletionOn mergeCommitTemplate mergeRequestTitleRegex mergeRequestTitleRegexDescription
      mergeRequestsDefaultTargetSelf mergeRequestsDisableCommittersApproval mergeRequestsEnabled
      mergeRequestsFfOnlyEnabled name nameWithNamespace onlyAllowMergeIfAllDiscussionsAreResolved
      onlyAllowMergeIfAllStatusChecksPassed onlyAllowMergeIfPipelineSucceeds openIssuesCount
      openMergeRequestsCount organizationEditPath pagesForceHttps pagesUseUniqueDomain path
      permanentDeletionDate preReceiveSecretDetectionEnabled preventMergeWithoutJiraIssueEnabled
      printingMergeRequestLinkEnabled protectableBranches publicJobs removeSourceBranchAfterMerge
      repositorySizeExcess requestAccessEnabled secretPushProtectionEnabled securityConfigurationPath
      securityDashboardPath securityPolicyPipelineMustSucceed serviceDeskAddress serviceDeskEnabled
      sharedRunnersEnabled snippetsEnabled squashCommitTemplate squashReadOnly sshUrlToRepo starCount
      suggestionCommitMessage tagList topics trackingKey transferInProgress updatedAt visibility
      vulnerabilityIdentifierSearch webBasedCommitSigningEnabled webPath webUrl wikiEnabled`),
    accountLeaves: words(`
      canCurrentUserPushToBranch canModifyBlob canModifyBlobWithWebIde canPlayJob createNoteEmail subscribed
      troubleshootJobWithAi`),
    arguments: words(`
      after:String@ApprovalRule.approvedBy approvedBy:String@Project.mergeRequests
      approver:String@Project.mergeRequests archived:Boolean@Project.labels assigneeId:String@Project.issue
      assigneeUsername:String@Project.issue assigneeUsernames:String@Project.issue
      assigneeWildcardId:AssigneeWildcardId@Project.issue author:String@Repository.commits
      authorUsername:String@Project.issue before:String@ApprovalRule.approvedBy
      blobPath:String@Project.mergeRequests closedAfter:Time@Project.issue closedBefore:Time@Project.issue
      committedAfter:Time@Repository.commits committedBefore:Time@Repository.commits
      confidential:Boolean@Project.issue createdAfter:Time@Project.issue createdBefore:Time@Project.issue
      crmContactId:String@Project.issue crmOrganizationId:String@Project.issue
      customField:WorkItemWidgetCustomFieldFilterInputType@Project.issue
      deployedAfter:Time@Project.mergeRequests deployedBefore:Time@Project.mergeRequests
      deploymentId:String@Project.mergeRequests draft:Boolean@Project.mergeRequests
      dueAfter:Time@Project.issue dueBefore:Time@Project.issue environmentName:String@Project.mergeRequests
      epicId:String@Project.issue epicWildcardId:EpicWildcardId@Project.issue
      filter:NotesFilterType@Commit.notes first:Int@ApprovalRule.approvedBy
      firstParent:Boolean@Repository.commits format:ShaFormat@Pipeline.sha full:Boolean@MergeRequest.reference
      fuzzySearch:Boolean@Project.labels healthStatus:HealthStatus@Project.issue
      healthStatusFilter:HealthStatusFilter@Project.issue id:CiPipelineID@Project.pipeline
      ids:ID@Commit.pipelines ignoredReviewerUsername:String@Project.mergeRequests iid:ID@Project.pipeline
      iid:String@Project.issue iids:String@Project.issue in:IssuableSearchableField@Project.issue
      includeAncestorGroups:Boolean@Project.labels includeSubepics:Boolean@Project.issue
      iterationCadenceId:IterationsCadenceID@Project.issue iterationId:ID@Project.issue
      iterationTitle:String@Project.issue iterationWildcardId:IterationWildcardId@Project.issue
      jobKind:CiJobKind@Pipeline.jobs kind:CiJobKind@Project.jobs labelName:String@Project.issue
      labels:String@Project.mergeRequests last:Int@ApprovalRule.approvedBy limit:Int@CiJobConnection.count
      mergedAfter:Time@Project.mergeRequests mergedBefore:Time@Project.mergeRequests
      mergedBy:String@Project.mergeRequests milestoneTitle:String@Project.issue
      milestoneWildcardId:MilestoneWildcardId@Project.issue myReactionEmoji:String@Project.issue
      name:String@Project.jobs not:MergeRequestsResolverNegatedParams@Project.mergeRequests
      not:NegatedIssueFilterInput@Project.issue offset:Int@Repository.branchNames
      or:UnionedIssueFilterInput@Project.issue or:UnionedMergeRequestFilterInput@Project.mergeRequests
      order:CommitOrder@Repository.commits path:String@MergeRequest.diffStats paths:String@Repository.blobs
      pipelineIid:String@Project.jobs query:UntrustedRegexp@Repository.commits
      recursive:Boolean@Repository.tree ref:String@Commit.pipelines refType:RefType@Commit.pipelines
      releaseTag:String@Project.issue releaseTagWildcardId:ReleaseTagWildcardId@Project.issue
      retried:Boolean@Pipeline.jobs reviewState:MergeRequestReviewState@Project.mergeRequests
      reviewStates:MergeRequestReviewState@Project.mergeRequests reviewerUsername:String@Project.mergeRequests
      reviewerWildcardId:ReviewerWildcardId@Project.mergeRequests scope:PipelineScopeEnum@Commit.pipelines
      search:String@Project.issue searchIn:LabelSearchFieldList@Project.labels
      searchPattern:String@Repository.branchNames searchTerm:String@Project.labels
      securityReportTypes:SecurityReportTypeEnum@Pipeline.jobs sha:String@Commit.pipelines
      sort:IssueSort@Project.issue sort:MergeRequestSort@Project.mergeRequests
      sort:ReleaseSort@Project.releases source:String@Commit.pipelines
      sourceBranches:String@Project.mergeRequests sources:CiJobSource@Project.jobs
      state:IssuableState@Project.issue state:MergeRequestState@Project.mergeRequests
      status:PipelineStatusEnum@Commit.pipelines status:WorkItemWidgetStatusFilterInput@Project.issue
      statuses:CiJobStatus@Pipeline.jobs subscribed:SubscriptionStatus@Project.issue
      tagName:String@Project.release targetBranches:String@Project.mergeRequests title:String@Project.labels
      types:IssueType@Project.issue updatedAfter:Time@Commit.pipelines updatedBefore:Time@Commit.pipelines
      username:String@Commit.pipelines weight:String@Project.issue
      weightWildcardId:WeightWildcardId@Project.issue whenExecuted:String@Pipeline.jobs
      withArtifacts:Boolean@Project.jobs workItemTypeIds:WorkItemsTypeID@Project.issue`),
  },
};

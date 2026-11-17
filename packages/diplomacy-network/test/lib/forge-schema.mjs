// What the two forges' published GraphQL schemas say of the types a task's document can
// reach inside the pool's repository: the facts the document check's tables are held to.
// Written from the schemas named in `source` by walking them from the repository type
// along the tables of src/requester/graphql.js; a field name added to those tables calls
// for the walk to be made again.

const words = (text) => text.split(/\s+/).filter(Boolean);

/// Per forge:
///   repository        the type of the pool's repository itself
///   repositoryLeaves  every scalar field of that type
///   repositoryObjects every other field of it: the ones a selection set is given to
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
    repositoryObjects: words(`
      assignableUsers branchProtectionRules codeOfConduct codeowners collaborators commitComments contactLinks
      contributingGuidelines defaultBranchRef dependencyGraphManifests deployKeys deployments discussion
      discussionCategories discussionCategory discussions environment environments forks fundingLinks
      interactionAbility issue issueFields issueOrPullRequest issueTemplates issueType issueTypes issues label
      labels languages latestRelease licenseInfo mentionableUsers mergeQueue milestone milestones object owner
      packages parent pinnedDiscussions pinnedEnvironments pinnedIssueFields pinnedIssues planFeatures
      planningStatuses primaryLanguage project projectV2 projects projectsV2 pullRequest
      pullRequestCreationCapConfig pullRequestTemplates pullRequests recentProjects ref refs release releases
      repositoryCopilotCodeReviewSettings repositoryCustomPropertyValue repositoryCustomPropertyValues
      repositoryTopics ruleset rulesets stargazers submodules suggestedActors templateRepository
      viewerContentWarning vulnerabilityAlert vulnerabilityAlerts watchers`),
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
      mergeType:PullRequestMergeMethod@PullRequest.viewerMergeBodyText
      name:String@ProjectV2Item.fieldValueByName number:Int@CheckRun.steps oid:GitObjectID@Repository.object
      orderBy:IssueCommentOrder@Issue.comments orderBy:IssueDependencyOrder@Issue.blockedBy
      orderBy:IssueOrder@Label.issues orderBy:LabelOrder@Discussion.labels
      orderBy:PullRequestOrder@Commit.associatedPullRequests orderBy:ReactionOrder@CommitComment.reactions
      orderBy:RefOrder@Repository.refs orderByState:Boolean@Issue.closedByPullRequestsReferences
      path:String@Commit.blame pullRequestId:ID@CheckRun.isRequired pullRequestNumber:Int@CheckRun.isRequired
      qualifiedName:String@Repository.ref query:String@Repository.refs refName:String@Repository.codeowners
      refPrefix:String@Repository.refs since:DateTime@Issue.timelineItems since:GitTimestamp@Commit.history
      size:Int@Bot.avatarUrl skip:Int@Issue.timelineItems states:IssueState@Label.issues
      states:PullRequestReviewState@PullRequest.reviews states:PullRequestState@Label.pullRequests
      states:TrackedIssueStates@Issue.trackedIssuesCount until:GitTimestamp@Commit.history
      userLinkedOnly:Boolean@Issue.closedByPullRequestsReferences
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
    repositoryObjects: words(`
      agentConfigurations aiAgentIdentities aiCatalogItem aiCatalogItemConsumerForItem aiCatalogItems
      aiFlowTriggers aiGovernanceMetrics aiGovernanceSessions aiGovernanceToolCalls aiMetrics aiUsageData
      aiUserMetrics aiXrayReports alertManagementAlert alertManagementAlertStatusCounts alertManagementAlerts
      alertManagementHttpIntegrations alertManagementIntegrations alertManagementPayloadFields analytics
      analyzerStatuses apiFuzzingCiConfiguration approvalPolicies ascpComponents ascpScans autocompleteUsers
      availableDeployKeys board boards branchRules ciAccessAuthorizedAgents ciCdSettings ciConfigVariables
      ciDownstreamProjectSubscriptions ciJobTokenAuthLogs ciJobTokenScope ciJobTokenScopeAllowlist
      ciPipelineCreationInputs ciPipelineCreationRequest ciSubscribedProjects ciSubscriptionsProjects
      ciTemplate ciUpstreamProjectSubscriptions ciVariables clusterAgent clusterAgents codeCoverageSummary
      commitReferences complianceControlStatus complianceFrameworks complianceRequirementStatuses
      complianceStandardsAdherence componentUsages componentVersions components containerExpirationPolicy
      containerProtectionRepositoryRules containerProtectionTagRules containerRepositories
      containerTagsExpirationPolicy corpuses customAttributes customizableDashboardVisualizations
      customizableDashboards dapFactoryConfiguration dapFactoryConfigurationValidation dastProfile
      dastProfiles dastScannerProfiles dastSiteProfile dastSiteProfiles dastSiteValidations dataTransfer
      defaultMergeRequestTarget dependencies dependencyFirewallActivitySummary dependencyFirewallRuleActivity
      dependencyPaths dependencyProxyPackagesSetting dependencyTrackedRefs deployment detailedImportStatus
      dora duoContextExclusionSettings duoWorkflowEvents duoWorkflowSessionArtifacts duoWorkflowStatusCheck
      duoWorkflowWorkflows environment environments flowMetrics forkDetails forkTargets forkedFrom
      forkingAccessLevel gitlabSubscriptionsPreviewBillableUserChange googleCloudArtifactRegistryRepository
      grafanaIntegration group incidentManagementEscalationPolicies incidentManagementEscalationPolicy
      incidentManagementOncallSchedules incidentManagementTimelineEvent incidentManagementTimelineEventTags
      incidentManagementTimelineEvents inheritedCiVariables issue issueStatusCounts issues issuesAccessLevel
      iterationCadences iterations jiraImports job jobAnalytics jobs label labels languages
      licensedFeatureAvailability maxAccessLevel memberRoles mergeRequest mergeRequestViolations mergeRequests
      mergeRequestsAccessLevel mergeTrains milestones mlExperiments mlModels namespace nestedEnvironments
      newMergeRequestPipelines observabilityLogsLinks observabilityMetricsLinks observabilityTracesLinks orbit
      packages packagesCleanupPolicy packagesProtectionRules pagesDeployments pathLocks pendingMemberApprovals
      pipeline pipelineAnalytics pipelineCounts pipelineExecutionPolicies pipelineExecutionSchedulePolicies
      pipelineScheduleStatusCounts pipelineSchedules pipelineTriggers pipelines policyStore projectMembers
      projectPlanLimits pushRules recentIssueBoards release releases repository requirement
      requirementStatesCount requirements rootGroup runnerCloudProvisioning runners sastCiConfiguration
      savedReplies savedReply scanExecutionPolicies scanProfileStatuses scanResultPolicies securityAttributes
      securityExclusion securityExclusions securityMetrics securityPolicies securityPolicyEligibleProjects
      securityPolicyProject securityPolicyProjectLinkedGroups securityPolicyProjectLinkedNamespaces
      securityPolicyProjectLinkedProjects securityPolicyProjectSuggestions securityScanProfiles
      securityScanners securityTrackedRefs securityTrainingProviders securityTrainingUrls sentryDetailedError
      sentryErrors services snippets sourcedMergeRequests statistics statisticsDetailsPaths targetBranchRules
      terraformState terraformStateProtectionRules terraformStates timelogCategories timelogs
      triageAndRemediationCoverage unprotectedBranches userAccessAuthorizedAgents userPermissions
      valueStreamAnalytics valueStreamDashboardUsageOverview valueStreams visibleForks vulnerabilities
      vulnerabilitiesCountByDay vulnerabilityArchives vulnerabilityImages vulnerabilityManagementPolicies
      vulnerabilityScanners vulnerabilitySeveritiesCount vulnerabilityStatistic vulnerabilityWorkflowExecution
      webhook wikiPages workItemStateCounts workItemTypes workItems`),
    accountLeaves: words(`
      canCurrentUserPushToBranch canModifyBlob canModifyBlobWithWebIde canPlayJob createNoteEmail subscribed
      troubleshootJobWithAi`),
    arguments: words(`
      after:String@ApprovalRule.approvedBy approvedBy:String@Project.mergeRequests
      approver:String@Project.mergeRequests assigneeId:String@Project.issue
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
      healthStatus:HealthStatus@Project.issue healthStatusFilter:HealthStatusFilter@Project.issue
      ignoredReviewerUsername:String@Project.mergeRequests iid:String@Project.issue iids:String@Project.issue
      in:IssuableSearchableField@Project.issue includeSubepics:Boolean@Project.issue
      iterationCadenceId:IterationsCadenceID@Project.issue iterationId:ID@Project.issue
      iterationTitle:String@Project.issue iterationWildcardId:IterationWildcardId@Project.issue
      jobKind:CiJobKind@Pipeline.jobs labelName:String@Project.issue labels:String@Project.mergeRequests
      last:Int@ApprovalRule.approvedBy limit:Int@CiJobConnection.count mergedAfter:Time@Project.mergeRequests
      mergedBefore:Time@Project.mergeRequests mergedBy:String@Project.mergeRequests
      milestoneTitle:String@Project.issue milestoneWildcardId:MilestoneWildcardId@Project.issue
      myReactionEmoji:String@Project.issue not:MergeRequestsResolverNegatedParams@Project.mergeRequests
      not:NegatedIssueFilterInput@Project.issue offset:Int@Repository.branchNames
      or:UnionedIssueFilterInput@Project.issue or:UnionedMergeRequestFilterInput@Project.mergeRequests
      order:CommitOrder@Repository.commits path:String@MergeRequest.diffStats paths:String@Repository.blobs
      query:UntrustedRegexp@Repository.commits recursive:Boolean@Repository.tree ref:String@Repository.blobs
      refType:RefType@Repository.blobs releaseTag:String@Project.issue
      releaseTagWildcardId:ReleaseTagWildcardId@Project.issue retried:Boolean@Pipeline.jobs
      reviewState:MergeRequestReviewState@Project.mergeRequests
      reviewStates:MergeRequestReviewState@Project.mergeRequests reviewerUsername:String@Project.mergeRequests
      reviewerWildcardId:ReviewerWildcardId@Project.mergeRequests search:String@Project.issue
      searchPattern:String@Repository.branchNames securityReportTypes:SecurityReportTypeEnum@Pipeline.jobs
      sort:IssueSort@Project.issue sort:MergeRequestSort@Project.mergeRequests
      sourceBranches:String@Project.mergeRequests state:IssuableState@Project.issue
      state:MergeRequestState@Project.mergeRequests status:WorkItemWidgetStatusFilterInput@Project.issue
      statuses:CiJobStatus@Pipeline.jobs subscribed:SubscriptionStatus@Project.issue
      targetBranches:String@Project.mergeRequests types:IssueType@Project.issue
      updatedAfter:Time@Project.issue updatedBefore:Time@Project.issue weight:String@Project.issue
      weightWildcardId:WeightWildcardId@Project.issue whenExecuted:String@Pipeline.jobs
      workItemTypeIds:WorkItemsTypeID@Project.issue`),
  },
};

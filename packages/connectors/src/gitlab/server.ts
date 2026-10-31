import type { McpHttpRuntime, ServerSource, ToolGuard } from '@kodra-agent/schema';

/**
 * zereight/gitlab-mcp 2.1.68 (npm @zereight/mcp-gitlab), shared by the GitLab and GitLab CI
 * connectors. See docs/connectors/gitlab.md.
 */
export const GITLAB_SERVER: ServerSource = {
  kind: 'npm',
  package: '@zereight/mcp-gitlab',
  version: '2.1.68',
  command: 'mcp-gitlab',
};

/**
 * The server's own filter cannot hold an allowlist: GITLAB_DENIED_TOOLS_REGEX longer than
 * 200 characters, or with nested quantifiers, is ignored (and every tool is offered). So the
 * server gets a short deny pattern for the dangerous tools, and every other tool this exact
 * version offers is listed below as hidden; the host drops them. A new tool in an upgrade
 * shows up as unclassified, which the real-server test catches.
 */
export const GITLAB_DENY_PATTERN =
  '^(merge_|approve_|unapprove_|update_default|update_project|protect_|unprotect_|create_repository|fork_|create_group|execute_graphql|delete_|create_label|update_label)';

/** Offered by 2.1.68 in modify mode with the default toolsets and the deny pattern, but not used. */
export const GITLAB_HIDDEN = [
  'bulk_publish_draft_notes',
  'create_commit_status',
  'create_draft_note',
  'create_issue_emoji_reaction',
  'create_issue_link',
  'create_issue_note_emoji_reaction',
  'create_merge_request_discussion_note',
  'create_merge_request_emoji_reaction',
  'create_merge_request_note_emoji_reaction',
  'create_merge_request_thread',
  'create_note',
  'discover_tools',
  'download_attachment',
  'get_branch_diffs',
  'get_ci_catalog_resource',
  'get_draft_note',
  'get_file_blame',
  'get_issue_link',
  'get_label',
  'get_merge_request_approval_state',
  'get_merge_request_conflicts',
  'get_merge_request_discussion',
  'get_merge_request_file_diff',
  'get_merge_request_note',
  'get_merge_request_version',
  'get_namespace',
  'get_project_events',
  'get_protected_branch',
  'get_user',
  'get_users',
  'health_check',
  'list_ci_catalog_resources',
  'list_draft_notes',
  'list_events',
  'list_group_iterations',
  'list_group_members',
  'list_group_merge_requests',
  'list_group_projects',
  'list_issue_emoji_reactions',
  'list_issue_links',
  'list_issue_note_emoji_reactions',
  'list_labels',
  'list_merge_request_diffs',
  'list_merge_request_emoji_reactions',
  'list_merge_request_note_emoji_reactions',
  'list_merge_request_pipelines',
  'list_merge_request_versions',
  'list_namespaces',
  'list_project_members',
  'list_projects',
  'list_protected_branches',
  'list_todos',
  'mark_all_todos_done',
  'mark_todo_done',
  'mr_discussions',
  'my_issues',
  'publish_draft_note',
  'resolve_merge_request_thread',
  'search_repositories',
  'update_draft_note',
  'update_issue_description_patch',
  'update_issue_note',
  'update_merge_request_discussion_note',
  'update_merge_request_note',
  'upload_markdown',
  'validate_ci_lint',
  'validate_project_ci_lint',
  'verify_namespace',
  'whoami',
] as const;

/** Offered by 2.1.68 with GITLAB_TOOLSETS=pipelines in modify mode, but not used. */
export const GITLAB_CI_HIDDEN = [
  'create_deployment',
  'create_pipeline_schedule',
  'create_pipeline_schedule_variable',
  'create_pipeline_trigger',
  'discover_tools',
  'download_job_artifacts',
  'get_deployment',
  'get_environment',
  'get_job_artifact_file',
  'get_pipeline_schedule',
  'get_pipeline_schedule_variable',
  'get_pipeline_test_report',
  'get_pipeline_trigger',
  'get_pipeline_variables',
  'list_deployment_merge_requests',
  'list_deployments',
  'list_environments',
  'list_job_artifacts',
  'list_pipeline_schedule_pipelines',
  'list_pipeline_schedules',
  'list_pipeline_trigger_jobs',
  'list_pipeline_triggers',
  'play_pipeline_jobs',
  'play_pipeline_schedule',
  'take_ownership_pipeline_schedule',
  'trigger_pipeline',
  'update_deployment',
  'update_environment',
  'update_pipeline_metadata',
  'update_pipeline_schedule',
  'update_pipeline_schedule_variable',
  'update_pipeline_trigger',
  'wait_for_job',
  'wait_for_pipeline',
] as const;

/**
 * Which server the GitLab connectors use (B4): GitLab's built-in MCP server (GitLab 19.5 and
 * newer), or the community server above for older GitLab. GitLab CI follows this setting.
 */
export const SERVER_FIELD = {
  kind: 'string' as const,
  key: 'server',
  required: false,
  description:
    "The MCP server: builtin is GitLab's own (GitLab 19.5 or newer, with MCP access allowed); community runs @zereight/mcp-gitlab in the agent, for older GitLab.",
  pattern: '^(builtin|community)$',
  patternHint: 'use builtin or community',
  default: 'builtin',
};

/** GitLab's built-in server at <url>/api/v4/mcp, with only the toolsets a connector uses. */
export function builtinRuntime(toolsets: string, from?: 'gitlab'): McpHttpRuntime {
  return {
    type: 'mcp-http',
    url: { setting: 'url', suffix: '/api/v4/mcp', ...(from ? { from } : {}) },
    headers: {
      Authorization: { bearer: { secret: 'token', ...(from ? { from } : {}) } },
      'X-Gitlab-Enabled-Mcp-Server-Toolsets': { value: toolsets },
    },
  };
}

/** A GitLab `url` argument names its own project, past the project_id the allowlist checks. */
export const noUrl: ToolGuard = {
  kind: 'arg-absent',
  arg: 'url',
  hint: 'name the project with project_id',
};

/**
 * Offered by GitLab's built-in server (19.6.0-pre) in the toolsets the GitLab connector asks
 * for, but never exposed: they reach past the listed projects (search, other projects and
 * groups, users, to-dos), merge or approve, or fork. Unlisted tools are hidden by the server.
 */
export const GITLAB_BUILTIN_HIDDEN = [
  'accept_merge_request',
  'fork_repository',
  'get_pages_content',
  'get_saved_view_work_items',
  'get_user',
  'link_work_items',
  'list_groups',
  'list_projects',
  'list_todos',
  'save_merge_request_review',
  'save_project',
  'search',
  'search_labels',
  'semantic_search',
] as const;

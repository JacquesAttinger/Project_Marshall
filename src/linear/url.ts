// Last edited: 2026-10-03 18:12 CDT
// The web URL of one Linear issue, built from the workspace slug and the human key. Pushes, the
// resolver's env, and the dashboard link to the same page; no API call is needed for it.

/** `https://linear.app/<workspace>/issue/<identifier>`. */
export function linearIssueUrl(workspace: string, identifier: string): string {
  return `https://linear.app/${workspace}/issue/${identifier}`;
}

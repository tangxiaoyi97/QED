# QED Changelog

## v1.1.22

- Added **Careless** mastery status (dashed circle). Use it for questions where the approach is understood but details or calculations need review.
- **Excluded** status now uses a slashed-circle marker, distinct from the careless dashed circle.
- Question workspace actions (question / answer / AI) moved into a view-switcher toolbar; rating buttons only appear in answer view.
- AI chat layout, dashboard, and dark mode coverage improved throughout.
- Added version update dialog: shown when the stored app version differs from the current one; writes the acknowledged version to user config on confirm.
- Version info now read from the running server at runtime instead of a build-time constant.
- Fixed all careless-related UI elements to use theme-adaptive colors instead of hardcoded blue.
- Fixed dark mode rendering for mastered stat chip.
- Cleaned up guest storage: config response now includes the `ui` field.

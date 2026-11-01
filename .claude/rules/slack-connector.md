---
paths:
  - "server/src/services/slack-client.ts"
  - "server/src/services/slack-connector.ts"
  - "server/src/routes/slack.ts"
  - "server/src/db/schema/slack.ts"
  - "server/tests/fakes/slack/**"
  - "admin/src/app/companies/*/integrations/slack.tsx"
  - "client/src/features/settings/components/SlackSection.tsx"
  - "client/electron/features/slack/**"
---

# The Slack connection (stage 3, lane A: A2 / A3)

Reserved for A2 and A3. Slack is a core connector serving the `chat` role (`connector-roles.md`).
Reading a member's DMs and mentions uses that member's own user grant (`member-oauth.md`
provider `slack`); notice DMs are sent by the company's bot. Events arrive at the fixed URL
`/api/slack/events/:companyId` (each company registers it in Slack, so it never moves), signed
requests only, one company never crossing into another. Channel messages are read but not kept;
no message body is stored. The server is the only place that talks to Slack; tests use the fake
Slack only. Write the rules here as A2 builds them.

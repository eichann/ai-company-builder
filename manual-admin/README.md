# Administrator / FDE guide (管理者・FDE の手引き)

The guide for the people who set a company up and run it: owners, admins and the FDE (the
engineer who helps a company start and automate its work). The member manual is `manual/`; this
is its counterpart for the admin console (`admin/`).

```
manual-admin/
  pages/<name>.md        the guide's text (Markdown, Japanese; index.md is the 序章)
  images/<name>.png      screenshots (none yet)
```

Status:

- **Not served yet.** The plan is to serve it to signed-in owners and admins from the admin
  console, like `/manual/` is served to signed-in accounts. Wiring it into a build, a server
  route or an admin page is a separate, reviewed change; nothing reads this folder today
  (`client/tests/manual-pages.test.ts` and the manual build read only `manual/`).
- **No pictures yet.** Where a picture belongs, a page has a placeholder line
  `［写真：<admin page path> — 何を写すか］`. Replace it with `![説明](../images/<name>.png)`
  once the picture exists; do not add an image link before the file is there.

Writing rules (same as `manual/`):

- Japanese for non-engineers; Git words only in sections marked 【FDE】, explained once.
- Button and label names as the screen shows them, in ［…］; other words in 「…」.
- Page names are ASCII `a-z`, `0-9` and `-`, numbered in reading order.
- Everything shown is fictional (検証A社, 高橋さん, 佐藤さん, 山田さん, 田中さん).
- Describe only what the code does today. Something being built gets at most one line saying so.

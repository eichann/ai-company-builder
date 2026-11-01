---
label: 顧客
version: 2
storage: server
fields:
  title:  { label: 会社名, kind: text, source: file }
  domain: { label: ドメイン, kind: text, source: server }
states: [active]
---
# 顧客

外の CRM の会社を写したもの（名前・ドメインと外の番号だけ）。ドメインは、議事録の外の参加者のメールから案件の候補を探すのに使う。

---
label: 顧客
version: 3
implements: [counterpart]
storage: server
fields:
  title:  { label: 会社名, kind: text, source: file }
  domain: { label: ドメイン, kind: text, source: server }
  counterpart_kind: { label: 会社か人か, kind: choice, options: [company, person], option_labels: { company: 会社, person: 人 }, source: server }
  email:  { label: メール, kind: text, source: server }
states: [active]
---
# 顧客

外の CRM の会社を写したもの（名前・ドメインと外の番号だけ）。「相手」の一つ（会社）。ドメインは、会議の社外の参加者のメールから案件の候補を探すのに使う。

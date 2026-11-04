---
label: お問い合わせ
version: 1
storage: server
fields:
  title:      { label: 件名, kind: text, source: file }
  person_ref: { label: 相手の番号, kind: text, source: server }
states: [open, closed]
initial: open
final: [closed]
actions:
  close_by_event: { label: 解決した, from: [open], to: closed, who: [admin] }
---
# お問い合わせ

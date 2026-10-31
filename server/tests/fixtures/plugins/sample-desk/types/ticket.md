---
label: 問い合わせ
version: 1
storage: server
fields:
  title:    { label: 件名, kind: text, source: file }
  priority: { label: 優先度, kind: choice, options: [high, normal], source: server }
  opened:   { label: 受付日, kind: date, source: server }
states: [open, closed]
---
# 問い合わせ

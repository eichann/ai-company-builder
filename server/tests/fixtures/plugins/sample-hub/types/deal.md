---
label: 案件
version: 1
storage: server
fields:
  title:      { label: 件名, kind: text, source: file }
  stage:      { label: 段階, kind: choice, options: [first_meeting, proposal, quote, final], source: server }
  confidence: { label: 確度, kind: choice, options: [a, b, c], source: server }
  next_step:  { label: 次のアクション, kind: text, source: server }
  close_date: { label: 受注予定日, kind: date, source: server }
  amount:     { label: 金額, kind: number, source: server }
  closed:     { label: 受注, kind: boolean, source: server }
  assignee:   { label: 担当, kind: person, source: server }
links:
  customer:   { label: 顧客, target: customer, cardinality: one, inverse: deals }
states: [open, won, lost]
initial: open
final: [won, lost]
---
# 案件

外の CRM の取引を写したもの（正は外の CRM）。

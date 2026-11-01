// The sample plugin's screens: show the context the core handed with the bridge, and read
// through the bridge only (a record section reads its record with records.get).
window.addEventListener('message', event => {
  const port = event.ports[0]
  if (!port || !event.data || event.data.type !== 'acb-bridge') return
  const context = event.data.context || {}
  const show = (id, text) => { document.getElementById(id).textContent = text }
  show('context', JSON.stringify(context))
  let next = 1
  const call = (op, args) => new Promise(resolve => {
    const id = next++
    const listener = e => { if (e.data && e.data.id === id) { port.removeEventListener('message', listener); resolve(e.data) } }
    port.addEventListener('message', listener)
    port.postMessage({ id, op, args })
  })
  port.start()
  if (context.slot === 'record_section') {
    call('records.get', { recordId: context.recordId }).then(a => show('answer', a.ok ? `記録：${a.data.record.title}` : `できません：${a.error.message}`))
  } else if (context.slot === 'file_action') {
    show('answer', `ファイル：${context.path}`)
  } else {
    call('records.query', { type: 'program_plan', limit: 5 }).then(a => show('answer', a.ok ? `企画 ${a.data.total} 件` : `できません：${a.error.message}`))
  }
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { VoiceHelperPool } from '../electron/voice-helper'

test('idle helper does not start capture; start preserves device and stop finalizes once', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'voice-standby-'))
  const cli = path.join(dir, 'helper')
  const ready = path.join(dir, 'ready')
  const started = path.join(dir, 'started')
  writeFileSync(cli, `#!${process.execPath}
const fs=require('node:fs');
if(!process.argv.includes('--standby')) process.exit(2);
fs.writeFileSync(${JSON.stringify(ready)},'ready');
console.log(JSON.stringify({type:'standby-ready'}));
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const command=JSON.parse(line); fs.writeFileSync(${JSON.stringify(started)},JSON.stringify(command));
 console.log(JSON.stringify({type:'listening',deviceName:'test'}));
}).on('close',()=>{ console.log(JSON.stringify({type:'result',text:'test'})); });
`, {mode:0o700})
  const pool = new VoiceHelperPool(cli)
  try {
    pool.warmUp(); pool.warmUp()
    for(let i=0;i<100 && !existsSync(ready);i++) await delay(20)
    assert.ok(existsSync(ready))
    assert.equal(existsSync(started),false)
    const events: string[] = []
    const control = pool.start(event=>events.push(event.type),'chosen-microphone')
    for(let i=0;i<100 && !events.includes('listening');i++) await delay(20)
    assert.deepEqual(JSON.parse(readFileSync(started,'utf8')),{command:'start',deviceId:'chosen-microphone'})
    control.stop()
    for(let i=0;i<100 && !events.includes('result');i++) await delay(20)
    assert.deepEqual(events,['listening','result'])
    control.cancel()
    pool.dispose()
    assert.throws(()=>pool.start(()=>{}),/終了/)
    await delay(100)
    assert.deepEqual(events,['listening','result'])
  } finally { pool.dispose(); await delay(100); rmSync(dir,{recursive:true,force:true}) }
})

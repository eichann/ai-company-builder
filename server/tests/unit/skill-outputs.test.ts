/**
 * Outputs never go into a Skill (owner decision 2026-11-10, `plugins.md` "The Skill shelf"):
 * `outputLikePaths` names the files of a Skill that look like outputs — what the app asks about
 * and the server refuses when a Skill goes to the company. A flag, not a security boundary.
 */
import { describe, expect, it } from 'vitest'
import { outputLikePaths } from '../../shared/core/skill-shelf'

describe('outputLikePaths', () => {
  it('flags everything under an output-like folder directly in the Skill', () => {
    const paths = ['SKILL.md', 'output/提案書.md', 'outputs/a.csv', 'out/x', 'result/r.txt', 'results/2026/r.txt', '成果物/見積.xlsx',
      '出力/a.md', 'export/a', 'exports/b', 'dist/index.js', 'generated/g.json']
    expect(outputLikePaths(paths)).toEqual(paths.slice(1))
  })

  it('folds case and width the way a protected name is compared', () => {
    expect(outputLikePaths(['Output/a.md', 'OUTPUTS/b.md', 'ＯＵＴＰＵＴ/c.md', 'Dist/d.js'])).toEqual(['Output/a.md', 'OUTPUTS/b.md', 'ＯＵＴＰＵＴ/c.md', 'Dist/d.js'])
  })

  it('leaves the same name deeper inside alone (a tool keeps its own folders)', () => {
    expect(outputLikePaths(['scripts/output/a.txt', 'tools/app/dist/index.js', 'references/results/r.md'])).toEqual([])
  })

  it('leaves the Skill\'s own parts and names that only start like one alone', () => {
    expect(outputLikePaths(['SKILL.md', 'scripts/run.py', 'references/guide.md', 'templates/base.md', 'rules/tone.md',
      'outline/a.md', 'output.md', 'outputs-guide/a.md', 'tools/README.md'])).toEqual([])
  })

  it('flags a deliverable file at the Skill\'s top, not in references/ or templates/', () => {
    expect(outputLikePaths(['提案書.pdf', 'report.DOCX', 'data.xlsx', 'deck.pptx', 'notes.md', 'data.csv'])).toEqual(['提案書.pdf', 'report.DOCX', 'data.xlsx', 'deck.pptx'])
    expect(outputLikePaths(['references/manual.pdf', 'templates/base.docx', 'templates/deck.pptx', 'references/table.xlsx'])).toEqual([])
    expect(outputLikePaths(['.pdf'])).toEqual([])
  })
})

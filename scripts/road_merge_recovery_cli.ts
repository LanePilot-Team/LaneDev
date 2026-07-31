import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { parseImported } from '../src/core/importmap'
import { roadsFromGeoJSON, type RoadFeature } from '../src/core/roads'
import { prepareBaseRoads } from '../src/core/pipeline'
import {
  applyToRoads, foldJournal, type EnhancementRecord,
} from '../src/core/enhancements'
import {
  buildRecoveryReport, buildReviewReport, reviewRowsSignature,
  type RoadMergeReviewReport,
} from './road_merge_recovery'

const argument = (name: string, fallback = '') =>
  process.argv.find((value) => value.startsWith(`--${name}=`))
    ?.slice(name.length + 3) ?? fallback

const databasePath = resolve(argument('db', 'public/data/road_database.json'))
const outputPath = resolve(argument(
  'json', `artifacts/road-merge-recovery-${new Date().toISOString().slice(0, 10)}.json`))
const sourceCommit = argument('source-commit')
const databaseJson = readFileSync(databasePath, 'utf8')
const databaseSha256 = createHash('sha256').update(databaseJson).digest('hex')
const db = JSON.parse(databaseJson)
const parsed = parseImported(db.segments.map((segment: unknown) => JSON.stringify(segment)).join('\n'))
if (parsed.kind !== 'map') throw new Error('靜態道路資料庫格式錯誤')
const { roads } = prepareBaseRoads(roadsFromGeoJSON(parsed.fc))
const journal = (db.editor?.journal ?? []) as EnhancementRecord[]
applyToRoads(roads, foldJournal(journal))
const active = roads.filter((road: RoadFeature) => !road.properties.deleted)
const report = buildRecoveryReport(active, journal, databasePath)
const reviewReport = buildReviewReport(report, databaseSha256, sourceCommit)
mkdirSync(dirname(outputPath), { recursive: true })
writeFileSync(outputPath, `${JSON.stringify(reviewReport, null, 2)}\n`, 'utf8')
console.log(`道路捏合復原報告：${outputPath}`)
console.log(`總計 ${report.rows.length}：${Object.entries(report.totals)
  .map(([status, count]) => `${status}=${count}`).join('｜')}`)
console.log(`處理：已升級=${reviewReport.summary.upgraded}｜已回退=${reviewReport.summary.rolledBack}`)

if (process.argv.includes('--apply')) {
  const approvedPathArg = argument('approved-report')
  if (!approvedPathArg) {
    throw new Error('--apply 必須搭配 --approved-report=<已人工核准的報告.json>')
  }
  const approvedPath = resolve(approvedPathArg)
  const approved = JSON.parse(readFileSync(approvedPath, 'utf8')) as RoadMergeReviewReport
  if (approved.format !== report.format) throw new Error('核准報告格式不符')
  if (approved.sourceDatabaseSha256 !== databaseSha256) {
    throw new Error('正式資料庫已變更，必須重新產生並審核復原報告')
  }
  if (approved.sourceCommit !== reviewReport.sourceCommit) {
    throw new Error('核准報告的來源 commit 與目前指定值不同')
  }
  if (reviewRowsSignature(approved.rows) !== reviewRowsSignature(reviewReport.rows)) {
    throw new Error('核准報告與目前重播結果不同，必須重新審核')
  }
  if (approved.summary.upgraded !== reviewReport.summary.upgraded
    || approved.summary.rolledBack !== reviewReport.summary.rolledBack) {
    throw new Error('核准報告的升級／回退數量與目前結果不同')
  }
  const candidatePath = resolve(argument(
    'output-db', 'artifacts/road_database-road-merge-v2-candidate.json'))
  const candidateDb = {
    ...db,
    editor: {
      ...(db.editor ?? {}),
      journal: [...journal, ...report.migrationCandidates],
    },
  }
  const candidateJson = `${JSON.stringify(candidateDb)}\n`
  writeFileSync(candidatePath, candidateJson, 'utf8')
  reviewReport.outputDatabaseSha256 = createHash('sha256').update(candidateJson).digest('hex')
  writeFileSync(outputPath, `${JSON.stringify(reviewReport, null, 2)}\n`, 'utf8')
  console.log(`已產生升級資料庫：${candidatePath}`)
  console.log(`升級資料 SHA-256：${reviewReport.outputDatabaseSha256}`)
}

/**
 * A bad release must undo in seconds. The ONE release lane is the shared step of
 * cargolink-release (candidate with no traffic, checks, promote, watch). No unit
 * test can deploy to Cloud Run, so this reads the SHAPE of cloudbuild.yaml and
 * proves the rules fire on the lane before the change (a plain `gcloud run
 * deploy` with no test: all traffic at once, no check, no way back).
 */
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const FILE = 'release/onerecorddemo.json'

function laneProblems(build) {
    const out = []
    const pins = [...build.matchAll(/cargolink\/cargolink-release:(\S+?)'?$/gmu)].map((m) => m[1])
    if (pins.length !== 1 || !/^\d+\.\d+\.\d+$/u.test(pins[0] ?? '')) {
        out.push('the release step is not pinned once by a version (_RELEASE_IMAGE)')
    }
    const steps = build.split(/\n {2}- (?:id|name): /u).slice(1)
    const release = steps.find((s) => s.includes('name: ${_RELEASE_IMAGE}') && s.includes('\n      - run\n'))
    if (!release) {
        out.push('no step runs the release step (`run`)')
    } else {
        for (const flag of [`--config=${FILE}`, '--build=$BUILD_ID', '--no-watch']) {
            if (!release.includes(`\n      - ${flag}`)) out.push(`the release step lacks ${flag}`)
        }
    }
    if (!steps.some((s) => s.includes(`'validate', '--config=${FILE}'`))) out.push('the release file is not validated in the build')
    if (steps.some((s) => /\n {6}- deploy\n/u.test(s))) out.push('a step deploys by itself (gcloud run deploy)')
    if (!steps.some((s) => s.includes('npm test'))) out.push('the build runs no tests')
    return out
}

describe('release lane', () => {
    it('releases through the pinned step after the tests, and nothing deploys by itself', () => {
        expect(laneProblems(readFileSync(join(__dirname, '..', 'cloudbuild.yaml'), 'utf8'))).toEqual([])
    })

    it('leaves the watch to the step default (5 min on the request log): no stages of its own', () => {
        const file = JSON.parse(readFileSync(join(__dirname, '..', FILE), 'utf8'))
        expect(file.stages).toBeUndefined()
    })

    // cargolink-release 1.29.0: the watch-/rollback- triggers run the version the release file names, and the step
    // refuses a file that names another one (2026-11-21: watch-cargolink-app ran an older step than its pin).
    it('names in the release file the step version that cloudbuild.yaml pins', () => {
        const build = readFileSync(join(__dirname, '..', 'cloudbuild.yaml'), 'utf8')
        const [pin] = [...build.matchAll(/cargolink\/cargolink-release:(\S+?)'?$/gmu)].map((m) => m[1])
        expect(JSON.parse(readFileSync(join(__dirname, '..', FILE), 'utf8')).step).toBe(pin)
    })

    it('fires on the lane before the change (plain gcloud run deploy, no tests)', () => {
        const old = `
steps:
  - name: gcr.io/cloud-builders/docker
    args:
      - push
  - name: gcr.io/google.com/cloudsdktool/cloud-sdk:slim
    entrypoint: gcloud
    args:
      - run
      - deploy
      - \${_SERVICE}
`
        expect(laneProblems(old)).toEqual(expect.arrayContaining([
            'the release step is not pinned once by a version (_RELEASE_IMAGE)',
            'no step runs the release step (`run`)',
            'the release file is not validated in the build',
            'a step deploys by itself (gcloud run deploy)',
            'the build runs no tests',
        ]))
    })
})

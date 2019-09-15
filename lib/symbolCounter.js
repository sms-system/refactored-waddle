const { GitRepo } = require('./git-client')
const { default: PQueue } = require('p-queue')

const numCPUs = require('os').cpus().length
const QUEUE_LIMIT = numCPUs

function countSymbols (data, symbolsMap, ignoreBinary) {
  for (let i = 0; i < data.length; i++) {
    const char = data[i]
    const charCode = char.charCodeAt(0)
    if (charCode === 13) { return }
    if (ignoreBinary && charCode < 32 && charCode !== 9 && charCode !== 10) { return char.charCodeAt(0) }
    const prevVal = symbolsMap[char]
    symbolsMap[char] = prevVal ? prevVal + 1 : 1
  }
}

process.on('message', ({ fileList, repoPath, commitHash, ignoreBinary }) => {
  const queue = new PQueue({ concurrency: QUEUE_LIMIT })
  const repo = new GitRepo(repoPath, null, false)
  const symbols = {}, ignoredFiles = []

  function processFile (repo, commitHash, fileName) {
    return new Promise(async (resolve) => {
      let doCount = true, localSymbols = {}
      repo.getBlobContent(commitHash, fileName, (data) => {
        if (!doCount) { return }
        const err = countSymbols(data.toString(), localSymbols, ignoreBinary)
        if (err) { doCount = false, ignoredFiles.push(fileName), resolve() }
      }, () => { doCount = false, ignoredFiles.push(fileName), resolve() }, () => {
        Object.keys(localSymbols).forEach(key => { symbols[key] = symbols[key] ? symbols[key] + localSymbols[key] : localSymbols[key] })
        resolve()
      })
    })
  }

  fileList.forEach(entry => {
    queue.add(() => processFile(repo, commitHash, entry.name))
  })

  queue.onIdle().then(() => {
    process.send({ symbols, ignoredFiles })
  })

})
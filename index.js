const express = require('express')
const mime = require('mime-types')
const { GitReposDir, GitRepo } = require('./lib/git-client')

const PORT = 8080
const REPOS_DIR = process.argv[2]

if (!REPOS_DIR) {
  throw 'Missed argument. Usage: "npm run start -- /path/to/repos" or "yarn start /path/to/repos" '
}

const errHandler = (res, code) => (err) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.status(code).json({ 'errorCode': err })
}

const app = express()
app.use(express.json())

app.param('repositoryId', (req, res, next, repositoryId) => {
  try {
    req.repo = new GitRepo(REPOS_DIR, repositoryId)
    next()
  }
  catch (err) {
    errHandler(res, 404)(err)
  }
})

app.use((req, res, next) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  if (req.repo) return next()
  try {
    req.reposDir = new GitReposDir(REPOS_DIR)
    next()
  }
  catch (err) {
    errHandler(res, 404)(err)
  }
})

function blobMiddleware (req, res, next) {
  res.setHeader('Content-Type', mime.lookup(req.url) || 'application/octet-stream')
  return next()
}

app.get('/api/repos', async (req, res) => {
  res.json(await req.reposDir.list())
})

// Send page positiion with `page` query
// Example: /api/repos/cool-timer/commits/master?page=3
app.get('/api/repos/:repositoryId/commits/:commitHash', (req, res) => {
  const { commitHash } = req.params
  const { page } = req.query
  req.repo.getCommits(commitHash, page,
    (data) => res.write(data),
    errHandler(res, 500),
    () => res.end()
  )
})

app.get('/api/repos/:repositoryId/commits/:commitHash/diff', (req, res) => {
  const { commitHash } = req.params
  req.repo.getCommitDiff(commitHash,
    (data) => res.write(data),
    errHandler(res, 500),
    () => res.end()
  )
})

function getTreeHandler (req, res) {
  const { commitHash, path } = req.params
  req.repo.getTree(commitHash, path, false,
    (data) => res.write(data),
    errHandler(res, 500),
    () => res.end()
  )
}

app.get('/api/repos/:repositoryId', getTreeHandler)
app.get('/api/repos/:repositoryId/tree/:commitHash/:path(*)', getTreeHandler)

app.get('/api/repos/:repositoryId/blob/:commitHash/:pathToFile(*)', blobMiddleware, (req, res) => {
  const { commitHash, pathToFile } = req.params
  req.repo.getBlobContent(commitHash, pathToFile,
    (data) => res.write(data),
    errHandler(res, 500),
    () => res.end()
  )
})

app.delete('/api/repos/:dirRepositoryId', (req, res) => {
  const { dirRepositoryId } = req.params
  req.reposDir.removeRepo(dirRepositoryId)
    .then(() => res.json({ status: 'OK' }))
    .catch(errHandler(res, 500))
})

app.delete('/api/repos/:dirRepositoryId', (req, res) => {
  const { dirRepositoryId } = req.params
  req.reposDir.removeRepo(dirRepositoryId)
    .then(() => res.json({ status: 'OK' }))
    .catch(errHandler(res, 500))
})

app.post('/api/repos', (req, res) => {
  const { url, repositoryId } = req.body
  req.reposDir.cloneRepo(url, repositoryId)
    .then(() => res.json({ status: 'OK' }))
    .catch(errHandler(res, 500))
})

app.listen(PORT, () => console.log(`Server started on port ${PORT}`))
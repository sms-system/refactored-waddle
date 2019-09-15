const express = require('express')
const mime = require('mime-types')
const bodyParser = require('body-parser')
const { GitReposDir, GitRepo } = require('./lib/git-client')

const PORT = 8080
const REPOS_DIR = '/data/Desktop/yandex'

const errHandler = (res, code) => (err) => res.status(code).json({ 'errorCode': err })

const app = express()
app.use(bodyParser.json())

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

app.get('/api/repos/:repositoryId/commits/:commitHash', (req, res) => {
  const { commitHash } = req.params
  req.repo.getCommits(commitHash,
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

app.get('/api/repos/:repositoryId', (req, res) => {
  req.repo.getTree(undefined, undefined, false,
    (data) => res.write(data),
    errHandler(res, 500),
    () => res.end()
  )
})

app.get('/api/repos/:repositoryId/tree/:commitHash/:path(*)', (req, res) => {
  const { commitHash, path } = req.params
  req.repo.getTree(commitHash, path, false,
    (data) => res.write(data),
    errHandler(res, 500),
    () => res.end()
  )
})

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

app.listen(PORT, () => console.log('Server started'))
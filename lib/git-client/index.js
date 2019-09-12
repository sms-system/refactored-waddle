const fs = require('fs')
const fsPromise = fs.promises
const path = require('path')
const { spawn } = require('child_process')

const ERRORS = require('./error-codes')
const GIT_DATA_FOLDER = '.git/'
const GIT_BINARY = 'git'
const GIT_CLONE_TIMEOUT = 30000

function isGitRepo (dirPath, repositoryId) {
  return fs.existsSync(path.join(dirPath, repositoryId, GIT_DATA_FOLDER))
}

function normalizeDirPath (name) {
  return path.normalize(name) + '/'
}

function sanitizeRepositoryId (name) {
  const normalizedName = normalizeDirPath(name)
  return !normalizedName || normalizedName.startsWith('../') ? null : normalizedName
}

async function rmrf (dirPath) {
  // I don't use recursive option in rmdir for backward compatibility with old node versions
  const entries = await fsPromise.readdir(dirPath, { withFileTypes: true })
  await Promise.all(entries.map(entry => {
    const fullPath = path.join(dirPath, entry.name)
    return entry.isDirectory() ? rmrf(fullPath) : fsPromise.unlink(fullPath)
  }))
  await fsPromise.rmdir(dirPath)
}

function setProcessTimeout(proc, callback, time) {
  return setTimeout(() => {
    proc.stdout.destroy()
    proc.stderr.destroy()
    proc.kill()
    callback()
  }, time)
}

class GitReposDir {
  constructor (dirPath) {
    this.path = normalizeDirPath(dirPath)
    if (!fs.existsSync(this.path)) throw ERRORS.REPOS_DIR_NOT_EXISTS
  }

  async list () {
    const entries = await fsPromise.readdir(this.path, { withFileTypes: true })
    return entries
      .filter(entry => entry.isDirectory() && isGitRepo(this.path, entry.name))
      .map(entry => entry.name)
  }

  async removeRepo (repositoryId) {
    const sanitizedRepositoryId = sanitizeRepositoryId(repositoryId)

    if (!sanitizedRepositoryId) throw ERRORS.HACKING_ATTEMPT
    if (!isGitRepo(this.path, sanitizedRepositoryId)) throw ERRORS.REPO_DOES_NOT_EXISTS

    await rmrf(path.join(this.path, sanitizedRepositoryId))
  }

  cloneRepo (repositoryId, url) {
    return new Promise((resolve, reject) => {
      const sanitizedRepositoryId = sanitizeRepositoryId(repositoryId)
      if (!sanitizedRepositoryId) return reject(ERRORS.HACKING_ATTEMPT)

      const child = spawn(GIT_BINARY, ['clone', url, path.join(this.path, sanitizedRepositoryId)])
      const execTimeout = setProcessTimeout(child, () => reject(ERRORS.TIMEOUT_EXCEEDED), GIT_CLONE_TIMEOUT)
      let errorMsg = ''

      child.stderr.on('data', (data) => {
        errorMsg = data.toString()
      })

      child.on('close', (code) => {
        clearTimeout(execTimeout)
        if (!code) return resolve(code)
        if (errorMsg.endsWith('already exists and is not an empty directory.\n')) return reject(ERRORS.REPO_ALREADY_EXISTS)
        if (errorMsg.startsWith('fatal: unable to access ')) return reject(ERRORS.INVALID_GIT_REPO_URL)
      })
    })
  }
}

class GitRepo {
  constructor (path, repositoryId) {

  }

  getCommits (commitHash) {

  }

  getCommitDiff (commitHash) {

  }

  getTree (commitHash, path) {

  }

  getBlobContent () {

  }

  getSymbolsCount () {

  }
}

module.exports = {
  GitReposDir,
  GitRepo
}
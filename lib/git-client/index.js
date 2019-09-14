const fs = require('fs')
const fsPromise = fs.promises
const path = require('path')
const { spawn } = require('child_process')

const ERRORS = require('./error-codes')
const GIT_DATA_FOLDER = '.git/'
const GIT_BINARY = 'git'
const GIT_CLONE_TIMEOUT = 60000

function isGitRepo (repoPath) {
  return fs.existsSync(path.join(repoPath, GIT_DATA_FOLDER))
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

function isLooksLikeArg (str) {
  return str.startsWith('-')
}

function getDelimeterKey (postfix) {
  return `__RND_DELIMETER__${(Math.random()*10e8).toString(36).replace('.', '_')}__${postfix}__`
}

function constructGitLogFmtTpl(obj, quoteDelimeter, endOfLineDelimeter) {
  const parts = Object.keys(obj).map((key) => `${quoteDelimeter}${key}${quoteDelimeter}: ${quoteDelimeter}${obj[key]}${quoteDelimeter}`)
  return `{${parts.join(',')}}${endOfLineDelimeter}`
}

function setProcessTimeout (proc, callback, time) {
  return setTimeout(() => {
    proc.stdout.destroy()
    proc.stderr.destroy()
    proc.kill()
    callback()
  }, time)
}

// Страшно выглядящая функция, для магии потокового эскепинга двойных кавычек в строке и экранирующая переносы
function getChunksJSONNormalizer (quoteDelimeter, endOfLineDelimeter) {
  const endOfLineDelimeterOnTheBorders = endOfLineDelimeter + '\n{'
  const maxRestLength = Math.max(quoteDelimeter.length, endOfLineDelimeterOnTheBorders.length)
  const doReplaces = (chunk) => chunk
    .replace(new RegExp(endOfLineDelimeterOnTheBorders, 'g'), ',{')
    .replace(/\\/g, '\\\\')
    .replace(/\r\n/g, '\\n')
    .replace(/\n/g, '\\n')
    .replace(/"/g, '\\\"')
    .replace(new RegExp(quoteDelimeter, 'g'), '"')

  let chunk, lastChunk = null
  const processor = function(data, handler) {
    if (!lastChunk) { lastChunk = data.toString(); return }
    const currentChunk = data.toString()
    const lastPlaceholderPos = Math.max(currentChunk.lastIndexOf(quoteDelimeter), currentChunk.lastIndexOf(endOfLineDelimeterOnTheBorders))
    if (lastPlaceholderPos !== -1) {
      chunk = lastChunk + currentChunk.substr(0, lastPlaceholderPos)
      lastChunk = currentChunk.substr(lastPlaceholderPos)
    } else {
      chunk = lastChunk + currentChunk.slice(0, -maxRestLength)
      lastChunk = currentChunk.slice(-maxRestLength)
    }
    handler(doReplaces(chunk))
  }
  processor.getLastChunk = () => lastChunk && doReplaces(lastChunk.replace(new RegExp(endOfLineDelimeter+'\n', 'g'), ''))

  return processor
}

function gitTreeRecordFormat (line) {
  const delimeterPos = line.indexOf('\t')
  const fileName = line.substr(delimeterPos + 1).replace(/^"|"$/g, '')
  const [mode, type, objHash, size] = line.substr(0, delimeterPos).split(/\s+/)
  return `{"name": "${fileName}", "type": "${type}", "size": "${size}", "objHash": "${objHash}", "mode": "${mode}"}`
}

class GitReposDir {
  constructor (dirPath) {
    this.path = normalizeDirPath(dirPath)
    if (!fs.existsSync(this.path)) throw ERRORS.REPOS_DIR_NOT_EXISTS
  }

  async list () {
    const entries = await fsPromise.readdir(this.path, { withFileTypes: true })
    return entries
      .filter(entry => entry.isDirectory() && isGitRepo(path.join(this.path, entry.name)))
      .map(entry => entry.name)
  }

  async removeRepo (repositoryId) {
    const sanitizedRepositoryId = sanitizeRepositoryId(repositoryId)

    if (!sanitizedRepositoryId) throw ERRORS.HACKING_ATTEMPT
    const repoPath = path.join(this.path, sanitizedRepositoryId)
    if (!isGitRepo(repoPath)) throw ERRORS.REPO_DOES_NOT_EXISTS

    await rmrf(repoPath)
  }

  cloneRepo (repositoryId, url) {
    return new Promise((resolve, reject) => {
      const sanitizedRepositoryId = sanitizeRepositoryId(repositoryId)
      if (!sanitizedRepositoryId) {
        return reject(ERRORS.HACKING_ATTEMPT)
      }

      const child = spawn(GIT_BINARY, ['clone', '--', url, sanitizedRepositoryId], {
        cwd: this.path, stdio: ['ignore', 'ignore', 'pipe']
      })
      const execTimeout = setProcessTimeout(child, () => reject(ERRORS.TIMEOUT_EXCEEDED), GIT_CLONE_TIMEOUT)

      let errorMsg = ''
      child.stderr.on('data', (data) => { errorMsg = data.toString() })

      child.on('close', (code) => {
        clearTimeout(execTimeout)
        if (!code) return resolve()
        if (errorMsg.endsWith('already exists and is not an empty directory.\n')) return reject(ERRORS.REPO_ALREADY_EXISTS)
        if (errorMsg.startsWith('fatal: unable to access ')) return reject(ERRORS.INVALID_GIT_REPO_URL)
        reject(ERRORS.UNEXPECTED_ERROR)
      })
    })
  }
}

class GitRepo {
  constructor (dirPath, repositoryId) {
    const sanitizedRepositoryId = sanitizeRepositoryId(repositoryId)
    if (!sanitizedRepositoryId) throw ERRORS.HACKING_ATTEMPT
    this.path = path.join(dirPath, sanitizedRepositoryId) + '/'
    if (!isGitRepo(this.path)) throw ERRORS.REPO_DOES_NOT_EXISTS
  }

  getCommits (commitHash, streamHandler, closeHandler = () => {}) {
    if (isLooksLikeArg(commitHash)) throw ERRORS.HACKING_ATTEMPT

    const QUOTE_DELIMETER = getDelimeterKey('QUOTE')
    const END_OF_LINE_DELIMETER = getDelimeterKey('EOL')
    const fmtTpl = constructGitLogFmtTpl({
      hash: '%H',
      parent: '%P',
      subject: '%s',
      body: '%b',
      time: '%at',
      author: '%aN <%ae>'
    }, QUOTE_DELIMETER, END_OF_LINE_DELIMETER)

    const child = spawn(GIT_BINARY, ['log' , `--format=${fmtTpl}`, commitHash, '--'], {
      cwd: this.path, stdio: ['ignore', 'pipe', 'pipe']
    })
    const chunkProcessor = getChunksJSONNormalizer(QUOTE_DELIMETER, END_OF_LINE_DELIMETER)

    let errorMsg = '', outputStarted = false
    child.stderr.on('data', (data) => { errorMsg = data.toString() })
    child.stdout.on('data', (data) => { chunkProcessor(data, (chunk) => {
      if (!outputStarted) { streamHandler('['); outputStarted = true }
      streamHandler(chunk)
    }) })
    child.on('close', (code) => {
      const lastChunk = chunkProcessor.getLastChunk()
      if (lastChunk) streamHandler(lastChunk + ']')
      closeHandler(code)
      if (!code) return
      if (errorMsg.startsWith('fatal: bad revision')) throw ERRORS.BRANCH_OR_COMMIT_DOES_NOT_EXISTS
      throw ERRORS.UNEXPECTED_ERROR
    })
  }

  getCommitDiff (commitHash, streamHandler, closeHandler = () => {}) {
    if (isLooksLikeArg(commitHash)) throw ERRORS.HACKING_ATTEMPT

    const child = spawn(GIT_BINARY, ['show' , '-m', commitHash, '--'], {
      cwd: this.path, stdio: ['ignore', 'pipe', 'pipe']
    })

    let errorMsg = '', outputStarted = false
    child.stderr.on('data', (data) => { errorMsg = data.toString() })
    child.stdout.on('data', (data) => {
      if (!outputStarted) { streamHandler('{"diffContent":"'); outputStarted = true }
      streamHandler(data.toString().replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n'))
    })
    child.on('close', (code) => {
      if (outputStarted) { streamHandler('"}') }
      closeHandler(code)
      if (!code) return
      if (errorMsg.startsWith('fatal: bad object')) throw ERRORS.BRANCH_OR_COMMIT_DOES_NOT_EXISTS
      throw ERRORS.UNEXPECTED_ERROR
    })
  }

  getTree (commitHash = 'master', dirPath, isRecursive = false, streamHandler, closeHandler = () => {}) {
    const child = spawn(GIT_BINARY, ['ls-tree' , '-l' + (isRecursive ? 'r' : ''), '--', commitHash + (dirPath? ':' + dirPath : '')], {
      cwd: this.path, stdio: ['ignore', 'pipe', 'pipe']
    })

    let errorMsg = '', outputStarted = false, prevChunk = '', isFirstChunk = true
    child.stderr.on('data', (data) => { errorMsg = data.toString() })
    child.stdout.on('data', (data) => {
      if (!outputStarted) { streamHandler('['); outputStarted = true }
      const lines = (prevChunk + data.toString()).split('\n')
      prevChunk = lines.pop()
      if (lines.length) {
        if (!isFirstChunk) { streamHandler(','); isFirstChunk = false }
        streamHandler(lines.map(line => gitTreeRecordFormat(line)).join(','))
      }
    })
    child.on('close', (code) => {
      if (prevChunk.length) { streamHandler(',' + gitTreeRecordFormat(prevChunk)) }
      if (outputStarted) { streamHandler(']') }
      closeHandler(code)
      if (!code) return
      if (errorMsg.startsWith('fatal: Not a valid object name')) throw ERRORS.BRANCH_OR_COMMIT_DOES_NOT_EXISTS
      throw ERRORS.UNEXPECTED_ERROR
    })
  }

  getBlobContent (commitHash, filePath, streamHandler, closeHandler = () => {}) {
    if (isLooksLikeArg(commitHash) || commitHash.indexOf(':') >= 0) throw ERRORS.HACKING_ATTEMPT

    const child = spawn(GIT_BINARY, ['show' ,`${commitHash}:${filePath}`], {
      cwd: this.path, stdio: ['ignore', 'pipe', 'pipe']
    })

    let errorMsg = ''
    child.stderr.on('data', (data) => { errorMsg = data.toString() })
    child.stdout.on('data', (data) => { streamHandler(data) })
    child.on('close', (code) => {
      closeHandler(code)
      if (!code) return
      if (errorMsg.startsWith('fatal: Invalid object name')) throw ERRORS.BRANCH_OR_COMMIT_DOES_NOT_EXISTS
      if (errorMsg.startsWith('fatal: Path')) throw ERRORS.FILE_NOT_FOUND
      throw ERRORS.UNEXPECTED_ERROR
    })
  }

  getSymbolsCount () {

  }
}

module.exports = {
  GitReposDir,
  GitRepo
}
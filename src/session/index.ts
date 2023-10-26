import { SessionContextManager } from 'context/manager'
import { queueAnAppendToDocument } from 'helpers/fileSystem'
import * as vscode from 'vscode'

export interface SessionConfiguration {
  taskIdentifier: string
  includeLineNumbers: boolean
  enableNewFilesAndShellCommands: boolean
}

export interface SessionContext {
  id: string
  userId: string

  /**
   * Necessary for access to secrets to store API key the user enters
   */
  extensionContext: vscode.ExtensionContext
  configuration: SessionConfiguration

  lowLevelLogger: (text: string) => Promise<void>

  highLevelLogger: (text: string) => Promise<void>

  /**
   * This is the document where raw LLM request is logged. This is mostly for
   * development.
   */
  markdownLowLevelFeedbackDocument: vscode.TextDocument

  contextManager: SessionContextManager

  /**
   * When the user closes the editor with high level feedback this is our
   * signal to abort the session. Once LLM is running this will be set to a
   * function that will abort it.
   *
   * In the future we will have additional controls, such a suspending,
   * aborting subtasks, etc.
   */
  sessionAbortedEventEmitter: vscode.EventEmitter<void>

  /**
   * Will fire when the session has ended, if the session was aborted is
   * expected to be called after it. If it is not called, that means the
   * command most likely has a bug related to aborting. Will be disposed right
   * after.
   */
  sessionEndedEventEmitter: vscode.EventEmitter<void>

  /**
   * This is a list of subscriptions that will be disposed when the session is
   * closed.
   */
  subscriptions: vscode.Disposable[]
}

export async function startSession(
  context: vscode.ExtensionContext,
  execution: vscode.NotebookCellExecution,
): Promise<SessionContext> {
  /*
   * There's a hard assumption across the code base that there's at least one
   * folder within the workspace. More like there's a single folder within the
   * workspace. Abort early and say the extension does not support opening
   * standalone files without a mounted workplace folder.
   */
  if (!vscode.workspace.workspaceFolders) {
    throw new Error(
      'ai-task needs at least one mounted workplace folder to work, apologies for this limitation',
    )
  }

  const { sessionMarkdownLowLevelFeedbackDocument } =
    await createSessionLogDocuments()

  const lowLevelLogger = (text: string) =>
    queueAnAppendToDocument(sessionMarkdownLowLevelFeedbackDocument, text)

  const pendingEdits = new Map<string, Promise<void>>()

  const currentCellOutputContentMap = new Map<string, string>()
  const cellEditQueue: Record<string, string[]> = {}

  async function queueAnAppendToExecutionOutput(
    execution: vscode.NotebookCellExecution,
    text: string,
  ) {
    if (execution.token.isCancellationRequested) {
      return
    }
    const cellId = execution.cell.document.uri.toString()

    if (!cellEditQueue[cellId]) {
      cellEditQueue[cellId] = []
    }

    cellEditQueue[cellId].push(text)

    const processQueue = async () => {
      while (cellEditQueue[cellId] && cellEditQueue[cellId].length > 0) {
        const currentText = cellEditQueue[cellId].shift()

        let currentCellOutput = currentCellOutputContentMap.get(cellId) ?? ''
        currentCellOutput += currentText
        currentCellOutputContentMap.set(cellId, currentCellOutput)
        if (execution.token.isCancellationRequested) {
          return
        }
        await execution.replaceOutput(
          new vscode.NotebookCellOutput([
            vscode.NotebookCellOutputItem.text(
              currentCellOutput,
              'text/markdown',
            ),
          ]),
        )
      }
    }

    if (!pendingEdits.has(cellId)) {
      if (execution.token.isCancellationRequested) {
        return
      }
      const editPromise = processQueue()
      pendingEdits.set(cellId, editPromise)
      if (execution.token.isCancellationRequested) {
        return
      }
      await editPromise
      pendingEdits.delete(cellId)
    }
  }

  const highLevelLogger = async (text: string) => {
    void queueAnAppendToExecutionOutput(execution, text)
  }

  const cachedActiveEditor = vscode.window.activeTextEditor

  /*
   * Create document manager that will help us backdate edits throughout this
   * sessiong
   */
  const documentManager = new SessionContextManager(true)

  // Create an event emitter to notify anyone interested in session aborts
  const sessionAbortedEventEmitter = new vscode.EventEmitter<void>()
  /*
   * Another emitter for when session ends no matter if it was aborted or it
   * has run its course
   */
  const sessionEndedEventEmitter = new vscode.EventEmitter<void>()

  // / NOTE: We used to stop the session when the user closed the high level
  // feedback document, but i got feedback that tahts unexpected behavior + we
  // are moving to notebooks :D
  //
  // const textDocumentCloseSubscription = vscode.window.tabGroups.onDidChangeTabs(
  //   ({ closed: closedTabs }) => {
  //     /*
  //      * input contains viewType key: 'mainThreadWebview-markdown.preview'
  //      * Label has the format 'Preview <name of the file>'
  //      */
  //     if (
  //       closedTabs.find((tab) => {
  //         /*
  //          * Trying to be mindful of potential internationalization of the word
  //          * 'Preview'
  //          */
  //         const abortSignalDocumentName =
  //           sessionHighLevelFeedbackDocument.uri.path.split('/').at(-1)!
  //         return tab.label.includes(abortSignalDocumentName)
  //       })
  //     ) {
  //       sessionAbortedEventEmitter.fire()
  //     }
  //   },
  // )

  void vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'ai-task extension is working ...',
      cancellable: true,
    },
    async (_progress, cancellationToken) => {
      // Cancelled from a button on the progress view
      cancellationToken.onCancellationRequested(() => {
        sessionAbortedEventEmitter.fire()
      })

      // Does not matter how but the session has ended. Remove the progress.
      await new Promise((resolve) => {
        sessionEndedEventEmitter.event(resolve)
      })
    },
  )

  /**
   * We first try to get the user id from the settings. This is useful in case
   * I want to override it for my user to distinguish from real users. If not
   * found in the settings, we then try to get it from the global state. If
   * still not found, we generate a new user id, store it in the global state,
   * and use it. The user id is used for anonymous usage tracking.
   */
  let userId = vscode.workspace
    .getConfiguration('ai-task')
    .get<string>('userId')
  if (typeof userId !== 'string' || userId.length === 0) {
    userId = context.globalState.get<string>('userId')
    if (typeof userId !== 'string' || userId.length === 0) {
      userId = Math.random().toString(36).substring(7)
      await context.globalState.update('userId', userId)
    }
  }

  return {
    id: new Date().toISOString(),
    userId,
    extensionContext: context,
    configuration: {
      taskIdentifier: getBreadIdentifier(),
      includeLineNumbers: true,
      enableNewFilesAndShellCommands: true,
    },
    lowLevelLogger: lowLevelLogger,
    highLevelLogger: highLevelLogger,
    markdownLowLevelFeedbackDocument: sessionMarkdownLowLevelFeedbackDocument,
    contextManager: documentManager,
    sessionAbortedEventEmitter,
    sessionEndedEventEmitter,
    subscriptions: [],
  }
}

/** Persist session logs and cleanup */
export async function closeSession(
  sessionContext: SessionContext,
): Promise<void> {
  // await sessionContext.highLevelFeedbackDocument.save()
  await sessionContext.markdownLowLevelFeedbackDocument.save()

  /*
   * Schedule closing the editors matching the documents
   * Communicate to the user that the editors will be closed
   *
   * We can also try closing the tab https://code.visualstudio.com/api/references/vscode-api#TabGroups
   * I'm wondering if hide is not available only within code insiders
   *
   * Either way not sure if we should be closing the feedback preview, copilot
   * or continue don't really close their sidebar once they're don
   */
  /*
   * setTimeout(() => {
   * hide is deprecated and the method suggested instead is to close active
   * editor - not what I want :(
   *   vscode.window.visibleTextEditors[0].hide()
   *
   * }, 2000)
   */

  // Dispose all subscriptions
  sessionContext.subscriptions.forEach(
    (subscription) => void subscription.dispose(),
  )
  void sessionContext.contextManager.dispose()

  // Dispose event emitters
  sessionContext.sessionAbortedEventEmitter.dispose()

  sessionContext.sessionEndedEventEmitter.fire()
  sessionContext.sessionEndedEventEmitter.dispose()
}

export async function findMostRecentSessionLogIndexPrefix(
  sessionsDirectory: vscode.Uri,
) {
  // Check if directory exists before reading
  const directoryExists = await vscode.workspace.fs
    .stat(sessionsDirectory)
    .then(
      () => true,
      () => false,
    )
  if (!directoryExists) {
    return 0
  }

  const sessionLogFiles =
    await vscode.workspace.fs.readDirectory(sessionsDirectory)
  const sessionLogIndexPrefixes = sessionLogFiles.flatMap(([fileName, _]) => {
    const maybeNumber = Number(fileName.split('-')[0])
    return isNaN(maybeNumber) ? [] : [maybeNumber]
  })
  const mostRecentSessionLogIndexPrefix = Math.max(
    ...sessionLogIndexPrefixes,
    0,
  )
  return mostRecentSessionLogIndexPrefix
}

async function createSessionLogDocuments() {
  const taskMagicIdentifier = getBreadIdentifier()

  const sessionsDirectory = vscode.Uri.joinPath(
    vscode.workspace.workspaceFolders![0].uri,
    `.${taskMagicIdentifier}/sessions`,
  )

  // No need to wait for this to finish
  void (async () => {
    const gitignorePath = vscode.Uri.joinPath(sessionsDirectory, '.gitignore')
    const gitignoreExists = await vscode.workspace.fs.stat(gitignorePath).then(
      () => true,
      () => false,
    )
    if (!gitignoreExists) {
      await vscode.workspace.fs.writeFile(gitignorePath, Buffer.from('*\n'))
    }
  })()

  const nextIndex =
    (await findMostRecentSessionLogIndexPrefix(sessionsDirectory)) + 1

  const shortWeekday = new Date().toLocaleString('en-US', {
    weekday: 'short',
  })
  const sessionNameBeforeAddingTopicSuffix = `${nextIndex}-${shortWeekday}`

  const sessionMarkdownLowLevelFeedbackDocument =
    await createAndOpenEmptyDocument(
      sessionsDirectory,
      `${sessionNameBeforeAddingTopicSuffix}.raw.md`,
    )

  return {
    sessionMarkdownLowLevelFeedbackDocument,
  }
}

export async function createAndOpenEmptyDocument(
  sessionsDirectory: vscode.Uri,
  name: string,
) {
  const highLevelFeedbackPath = vscode.Uri.joinPath(sessionsDirectory, name)
  await vscode.workspace.fs.writeFile(highLevelFeedbackPath, new Uint8Array())
  // VSCode is known to be slow to update the file system
  await new Promise((resolve) => setTimeout(resolve, 100))

  const sessionMarkdownHighLevelFeedbackDocument =
    await vscode.workspace.openTextDocument(highLevelFeedbackPath)
  return sessionMarkdownHighLevelFeedbackDocument
}

/*
 * Refactor: We probably want a helper function to get the entire configuration
 * for the session instead of just the bread
 */
export function getBreadIdentifier(): string {
  const breadIdentifierFromWorkspace = vscode.workspace
    .getConfiguration('ai-task')
    .get('taskMentionIdentifier')

  /*
   * We are using the environment override for simplified manual and automated
   * testingbecause As we might be opening single files instead off full
   * workspace with settings.json.
   */
  const atBreadIdentifierOverride: any =
    process.env.AT_BREAD_IDENTIFIER_OVERRIDE ?? breadIdentifierFromWorkspace

  const safeAtBreadIdentifierOverride =
    typeof atBreadIdentifierOverride === 'string'
      ? atBreadIdentifierOverride
      : '@' + 'task' // Avoiding the magic string by splitting into half

  return safeAtBreadIdentifierOverride
}

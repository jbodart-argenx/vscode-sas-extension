// Copyright © 2023, SAS Institute Inc., Cary, NC, USA.  All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  CancellationToken,
  DataTransfer,
  DataTransferItem,
  Disposable,
  DocumentDropEdit,
  Event,
  EventEmitter,
  FileChangeEvent,
  FileStat,
  FileSystemProvider,
  FileType,
  Position,
  ProviderResult,
  Tab,
  TabInputNotebook,
  TabInputText,
  TextDocument,
  TextDocumentContentProvider,
  ThemeIcon,
  TreeDataProvider,
  TreeDragAndDropController,
  TreeItem,
  TreeItemCollapsibleState,
  TreeView,
  Uri,
  commands,
  l10n,
  languages,
  window,
  workspace,
} from "vscode";

import { lstat, lstatSync, readFile, readdir } from "fs";
import { basename, join } from "path";
import { promisify } from "util";

import { profileConfig } from "../../commands/profile";
import { SubscriptionProvider } from "../SubscriptionProvider";
import { ViyaProfile } from "../profile";
import { ContentModel } from "./ContentModel";
import {
  FAVORITES_FOLDER_TYPE,
  MYFOLDER_TYPE,
  Messages,
  ROOT_FOLDER_TYPE,
  TRASH_FOLDER_TYPE,
} from "./const";
import { convertNotebookToFlow } from "./convert";
import { ContentItem } from "./types";
import {
  getCreationDate,
  getFileStatement,
  getId,
  isContainer as getIsContainer,
  getLabel,
  getLink,
  getModifyDate,
  getResourceIdFromItem,
  getTypeName,
  getUri,
  isContainer,
  isItemInRecycleBin,
  isReference,
  resourceType,
} from "./utils";

const contentItemMimeType = "application/vnd.code.tree.contentdataprovider";
class ContentDataProvider
  implements
    TreeDataProvider<ContentItem>,
    FileSystemProvider,
    TextDocumentContentProvider,
    SubscriptionProvider,
    TreeDragAndDropController<ContentItem>
{
  private _onDidChangeFile: EventEmitter<FileChangeEvent[]>;
  private _onDidChangeTreeData: EventEmitter<ContentItem | undefined>;
  private _onDidChange: EventEmitter<Uri>;
  private _treeView: TreeView<ContentItem>;
  private _dropEditProvider: Disposable;
  private readonly model: ContentModel;
  private extensionUri: Uri;

  public dropMimeTypes: string[] = [contentItemMimeType, "text/uri-list"];
  public dragMimeTypes: string[] = [contentItemMimeType];

  get treeView(): TreeView<ContentItem> {
    return this._treeView;
  }

  constructor(model: ContentModel, extensionUri: Uri) {
    this._onDidChangeFile = new EventEmitter<FileChangeEvent[]>();
    this._onDidChangeTreeData = new EventEmitter<ContentItem | undefined>();
    this._onDidChange = new EventEmitter<Uri>();
    this.model = model;
    this.extensionUri = extensionUri;

    this._treeView = window.createTreeView("contentdataprovider", {
      treeDataProvider: this,
      dragAndDropController: this,
      canSelectMany: true,
    });
    this._dropEditProvider = languages.registerDocumentDropEditProvider(
      { language: "sas" },
      this,
    );

    this._treeView.onDidChangeVisibility(async () => {
      if (this._treeView.visible) {
        const activeProfile: ViyaProfile = profileConfig.getProfileByName(
          profileConfig.getActiveProfile(),
        );
        await this.connect(activeProfile.endpoint);
      }
    });
  }

  public async handleDrop(
    target: ContentItem,
    sources: DataTransfer,
  ): Promise<void> {
    for (const mimeType of this.dropMimeTypes) {
      const item = sources.get(mimeType);
      if (!item || !item.value) {
        continue;
      }

      switch (mimeType) {
        case contentItemMimeType:
          await Promise.all(
            item.value.map(
              async (contentItem: ContentItem) =>
                await this.handleContentItemDrop(target, contentItem),
            ),
          );
          break;
        case "text/uri-list":
          await this.handleDataTransferItemDrop(target, item);
          break;
        default:
          break;
      }
    }
  }

  public handleDrag(
    source: ContentItem[],
    dataTransfer: DataTransfer,
  ): void | Thenable<void> {
    const dataTransferItem = new DataTransferItem(source);
    dataTransfer.set(this.dragMimeTypes[0], dataTransferItem);
  }

  public async provideDocumentDropEdits(
    document: TextDocument,
    position: Position,
    dataTransfer: DataTransfer,
    token: CancellationToken,
  ): Promise<DocumentDropEdit | undefined> {
    const dataTransferItem = dataTransfer.get(this.dragMimeTypes[0]);
    const contentItem =
      dataTransferItem && JSON.parse(dataTransferItem.value)[0];
    if (token.isCancellationRequested || !contentItem) {
      return undefined;
    }

    const fileFolderPath = await this.model.getFileFolderPath(contentItem);
    if (!fileFolderPath) {
      return undefined;
    }

    return {
      insertText: getFileStatement(
        contentItem.name,
        document.getText(),
        fileFolderPath,
      ),
    };
  }

  public getSubscriptions(): Disposable[] {
    return [this._treeView, this._dropEditProvider];
  }

  get onDidChangeFile(): Event<FileChangeEvent[]> {
    return this._onDidChangeFile.event;
  }

  get onDidChangeTreeData(): Event<ContentItem> {
    return this._onDidChangeTreeData.event;
  }

  get onDidChange(): Event<Uri> {
    return this._onDidChange.event;
  }

  public async connect(baseUrl: string): Promise<void> {
    await this.model.connect(baseUrl);
    this.refresh();
  }

  public async getTreeItem(item: ContentItem): Promise<TreeItem> {
    const isContainer = getIsContainer(item);

    const uri = await this.getUri(item, false);

    return {
      iconPath: this.iconPathForItem(item),
      contextValue: resourceType(item),
      id: getId(item),
      label: getLabel(item),
      collapsibleState: isContainer
        ? TreeItemCollapsibleState.Collapsed
        : undefined,
      command: isContainer
        ? undefined
        : {
            command: "vscode.open",
            arguments: [uri],
            title: "Open SAS File",
          },
    };
  }

  public async provideTextDocumentContent(uri: Uri): Promise<string> {
    // use text document content provider to display the readonly editor for the files in the recycle bin
    return await this.model.getContentByUri(uri);
  }

  public getChildren(item?: ContentItem): ProviderResult<ContentItem[]> {
    return this.model.getChildren(item);
  }

  public watch(): Disposable {
    // ignore, fires for all changes...
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    return new Disposable(() => {});
  }

  public async stat(uri: Uri): Promise<FileStat> {
    return await this.model.getResourceByUri(uri).then(
      (resource): FileStat => ({
        type: getIsContainer(resource) ? FileType.Directory : FileType.File,
        ctime: getCreationDate(resource),
        mtime: getModifyDate(resource),
        size: 0,
      }),
    );
  }

  public async readFile(uri: Uri): Promise<Uint8Array> {
    return await this.model
      .getContentByUri(uri)
      .then((content) => new TextEncoder().encode(content));
  }

  public getUri(item: ContentItem, readOnly: boolean): Promise<Uri> {
    return this.model.getUri(item, readOnly);
  }

  public async createFolder(
    item: ContentItem,
    folderName: string,
  ): Promise<Uri | undefined> {
    const newItem = await this.model.createFolder(item, folderName);
    if (newItem) {
      this.refresh();
      return getUri(newItem);
    }
  }

  public async createFile(
    item: ContentItem,
    fileName: string,
    buffer?: ArrayBufferLike,
  ): Promise<Uri | undefined> {
    const newItem = await this.model.createFile(item, fileName, buffer);
    if (newItem) {
      this.refresh();
      return getUri(newItem);
    }
  }

  public async renameResource(
    item: ContentItem,
    name: string,
  ): Promise<Uri | undefined> {
    const closing = closeFileIfOpen(item);
    if (!(await closing)) {
      return;
    }
    const newItem = await this.model.renameResource(item, name);
    if (newItem) {
      const newUri = getUri(newItem);
      if (closing !== true) {
        // File was open before rename, so re-open it
        commands.executeCommand("vscode.open", newUri);
      }
      return newUri;
    }
  }

  public writeFile(uri: Uri, content: Uint8Array): void | Promise<void> {
    return this.model.saveContentToUri(uri, new TextDecoder().decode(content));
  }

  public async deleteResource(item: ContentItem): Promise<boolean> {
    if (!(await closeFileIfOpen(item))) {
      return false;
    }
    const success = await this.model.delete(item);
    if (success) {
      this.refresh();
    }
    return success;
  }

  public async recycleResource(item: ContentItem): Promise<boolean> {
    const recycleBin = this.model.getDelegateFolder("@myRecycleBin");
    if (!recycleBin) {
      // fallback to delete
      return this.deleteResource(item);
    }
    const recycleBinUri = getLink(recycleBin.links, "GET", "self")?.uri;
    if (!recycleBinUri) {
      return false;
    }
    if (!(await closeFileIfOpen(item))) {
      return false;
    }
    const success = await this.model.moveTo(item, recycleBinUri);
    if (success) {
      this.refresh();
      // update the text document content as well just in case that this file was just restored and updated
      this._onDidChange.fire(getUri(item, true));
    }
    return success;
  }

  public async restoreResource(item: ContentItem): Promise<boolean> {
    const previousParentUri = getLink(item.links, "GET", "previousParent")?.uri;
    if (!previousParentUri) {
      return false;
    }
    if (!(await closeFileIfOpen(item))) {
      return false;
    }
    const success = await this.model.moveTo(item, previousParentUri);
    if (success) {
      this.refresh();
    }
    return success;
  }

  public async emptyRecycleBin(): Promise<boolean> {
    const recycleBin = this.model.getDelegateFolder("@myRecycleBin");
    const children = await this.getChildren(recycleBin);
    const result = await Promise.all(
      children.map((child) => this.deleteResource(child)),
    );
    const success = result.length === children.length;
    if (success) {
      this.refresh();
    }
    return success;
  }

  public async addToMyFavorites(item: ContentItem): Promise<boolean> {
    const success = await this.model.addFavorite(item);
    if (success) {
      this.refresh();
    }
    return success;
  }

  public async removeFromMyFavorites(item: ContentItem): Promise<boolean> {
    const success = await this.model.removeFavorite(item);
    if (success) {
      this.refresh();
    }
    return success;
  }

  public async handleCreationResponse(
    resource: ContentItem,
    newUri: Uri | undefined,
    errorMessage: string,
  ): Promise<void> {
    if (!newUri) {
      window.showErrorMessage(errorMessage);
      return;
    }

    this.reveal(resource);
  }

  public async acquireStudioSessionId(endpoint: string): Promise<string> {
    if (endpoint && !this.model.connected()) {
      await this.connect(endpoint);
    }
    return await this.model.acquireStudioSessionId();
  }

  public async convertNotebookToFlow(
    inputName: string,
    outputName: string,
    content: string,
    studioSessionId: string,
    parentItem?: ContentItem,
  ): Promise<string> {
    if (!parentItem) {
      const rootFolders = await this.model.getChildren();
      const myFolder = rootFolders.find(
        (rootFolder) => rootFolder.type === MYFOLDER_TYPE,
      );
      if (!myFolder) {
        return "";
      }
      parentItem = myFolder;
    }

    try {
      // convert the notebook file to a .flw file
      const flowDataString = convertNotebookToFlow(
        content,
        inputName,
        outputName,
      );
      const flowDataUint8Array = new TextEncoder().encode(flowDataString);
      if (flowDataUint8Array.length === 0) {
        window.showErrorMessage(Messages.NoCodeToConvert);
        return;
      }
      const newUri = await this.createFile(
        parentItem,
        outputName,
        flowDataUint8Array,
      );
      this.handleCreationResponse(
        parentItem,
        newUri,
        l10n.t(Messages.NewFileCreationError, { name: inputName }),
      );
      // associate the new .flw file with SAS Studio
      await this.model.associateFlowFile(
        outputName,
        newUri,
        parentItem,
        studioSessionId,
      );
    } catch (error) {
      window.showErrorMessage(error);
    }

    return parentItem.name;
  }

  public refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  public async getParent(
    element: ContentItem,
  ): Promise<ContentItem | undefined> {
    return await this.model.getParent(element);
  }

  public async delete(): Promise<void> {
    throw new Error("Method not implemented.");
  }

  public rename(): void | Promise<void> {
    throw new Error("Method not implemented.");
  }

  public readDirectory():
    | [string, FileType][]
    | Thenable<[string, FileType][]> {
    throw new Error("Method not implemented.");
  }

  public createDirectory(): void | Thenable<void> {
    throw new Error("Method not implemented.");
  }

  public reveal(item: ContentItem): void {
    this._treeView.reveal(item, {
      expand: true,
      select: false,
      focus: false,
    });
  }

  public async uploadUrisToTarget(
    uris: Uri[],
    target: ContentItem,
  ): Promise<void> {
    const failedUploads = [];
    for (let i = 0; i < uris.length; ++i) {
      const uri = uris[i];
      const fileName = basename(uri.fsPath);
      if (lstatSync(uri.fsPath).isDirectory()) {
        const success = await this.handleFolderDrop(target, uri.fsPath, false);
        !success && failedUploads.push(fileName);
      } else {
        const file = await workspace.fs.readFile(uri);
        const newUri = await this.createFile(target, fileName, file);
        !newUri && failedUploads.push(fileName);
      }
    }

    if (failedUploads.length > 0) {
      this.handleCreationResponse(
        target,
        undefined,
        l10n.t(Messages.FileUploadError),
      );
    }
  }

  public async downloadContentItems(
    folderUri: Uri,
    selections: ContentItem[],
    allSelections: readonly ContentItem[],
  ): Promise<void> {
    for (let i = 0; i < selections.length; ++i) {
      const selection = selections[i];
      if (isContainer(selection)) {
        const newFolderUri = Uri.joinPath(folderUri, selection.name);
        const selectionsWithinFolder = await this.childrenSelections(
          selection,
          allSelections,
        );
        await workspace.fs.createDirectory(newFolderUri);
        await this.downloadContentItems(
          newFolderUri,
          selectionsWithinFolder,
          allSelections,
        );
      } else {
        await workspace.fs.writeFile(
          Uri.joinPath(folderUri, selection.name),
          await this.readFile(getUri(selection)),
        );
      }
    }
  }

  private async childrenSelections(
    selection: ContentItem,
    allSelections: readonly ContentItem[],
  ): Promise<ContentItem[]> {
    const foundSelections = allSelections.filter(
      (foundSelection) => foundSelection.parentFolderUri === selection.uri,
    );
    if (foundSelections.length > 0) {
      return foundSelections;
    }

    // If we don't have any child selections, then the folder must have been
    // closed and therefore, we expect to select _all_ children
    return this.getChildren(selection);
  }

  private async handleContentItemDrop(
    target: ContentItem,
    item: ContentItem,
  ): Promise<void> {
    let success = false;
    let message = Messages.FileDropError;
    if (item.flags.isInRecycleBin) {
      message = Messages.FileDragFromTrashError;
    } else if (isReference(item)) {
      message = Messages.FileDragFromFavorites;
    } else if (target.type === TRASH_FOLDER_TYPE) {
      success = await this.recycleResource(item);
    } else if (target.type === FAVORITES_FOLDER_TYPE) {
      success = await this.addToMyFavorites(item);
    } else {
      const targetUri = getResourceIdFromItem(target);
      if (targetUri) {
        success = await this.model.moveTo(item, targetUri);
      }

      if (success) {
        this.refresh();
      }
    }

    if (!success) {
      window.showErrorMessage(
        l10n.t(message, {
          name: item.name,
        }),
      );
    }
  }

  private async handleFolderDrop(
    target: ContentItem,
    path: string,
    displayErrorMessages: boolean = true,
  ): Promise<boolean> {
    const folder = await this.model.createFolder(target, basename(path));
    let success = true;
    if (!folder) {
      displayErrorMessages &&
        window.showErrorMessage(
          l10n.t(Messages.FileDropError, {
            name: basename(path),
          }),
        );

      return false;
    }

    // Read all the files in the folder and upload them
    const filesOrFolders = await promisify(readdir)(path);
    await Promise.all(
      filesOrFolders.map(async (fileOrFolderName: string) => {
        const fileOrFolder = join(path, fileOrFolderName);
        const isDirectory = (
          await promisify(lstat)(fileOrFolder)
        ).isDirectory();
        if (isDirectory) {
          success = await this.handleFolderDrop(folder, fileOrFolder);
        } else {
          const name = basename(fileOrFolder);
          const fileCreated = await this.createFile(
            folder,
            name,
            await promisify(readFile)(fileOrFolder),
          );
          if (!fileCreated) {
            success = false;
            displayErrorMessages &&
              window.showErrorMessage(
                l10n.t(Messages.FileDropError, {
                  name,
                }),
              );
          }
        }
      }),
    );

    return success;
  }

  private async handleDataTransferItemDrop(
    target: ContentItem,
    item: DataTransferItem,
  ): Promise<void> {
    // If a user drops multiple files, there will be multiple
    // uris separated by newlines
    await Promise.all(
      item.value.split("\n").map(async (uri: string) => {
        const itemUri = Uri.parse(uri.trim());
        const name = basename(itemUri.path);
        const isDirectory = (
          await promisify(lstat)(itemUri.fsPath)
        ).isDirectory();

        if (isDirectory) {
          const success = await this.handleFolderDrop(target, itemUri.fsPath);
          if (success) {
            this.refresh();
          }

          return;
        }

        const fileCreated = await this.createFile(
          target,
          name,
          await promisify(readFile)(itemUri.fsPath),
        );

        if (!fileCreated) {
          window.showErrorMessage(
            l10n.t(Messages.FileDropError, {
              name,
            }),
          );
        }
      }),
    );
  }

  private iconPathForItem(
    item: ContentItem,
  ): ThemeIcon | { light: Uri; dark: Uri } {
    const isContainer = getIsContainer(item);
    let icon = "";
    if (isContainer) {
      const type = getTypeName(item);
      switch (type) {
        case ROOT_FOLDER_TYPE:
          icon = "sasFolders";
          break;
        case TRASH_FOLDER_TYPE:
          icon = "delete";
          break;
        case FAVORITES_FOLDER_TYPE:
          icon = "favoritesFolder";
          break;
        default:
          icon = "folder";
          break;
      }
    } else {
      const extension = item.name.split(".").pop().toLowerCase();
      if (extension === "sas") {
        icon = "sasProgramFile";
      }
    }
    return icon !== ""
      ? {
          dark: Uri.joinPath(this.extensionUri, `icons/dark/${icon}Dark.svg`),
          light: Uri.joinPath(
            this.extensionUri,
            `icons/light/${icon}Light.svg`,
          ),
        }
      : ThemeIcon.File;
  }
}

export default ContentDataProvider;

const closeFileIfOpen = (item: ContentItem) => {
  const fileUri = getUri(item, isItemInRecycleBin(item));
  const tabs: Tab[] = window.tabGroups.all.map((tg) => tg.tabs).flat();
  const tab = tabs.find(
    (tab) =>
      (tab.input instanceof TabInputText ||
        tab.input instanceof TabInputNotebook) &&
      tab.input.uri.query === fileUri.query, // compare the file id
  );
  if (tab) {
    return window.tabGroups.close(tab);
  }
  return true;
};

import type { ApiLanguageServiceContext } from '../types';
import type { Position } from 'vscode-languageserver/node';
import type { WorkspaceEdit } from 'vscode-languageserver/node';
import * as dedupe from '../utils/dedupe';
import { TextDocumentEdit } from 'vscode-languageserver/node';
import { CreateFile } from 'vscode-languageserver/node';
import { RenameFile } from 'vscode-languageserver/node';
import { DeleteFile } from 'vscode-languageserver/node';
import { AnnotatedTextEdit } from 'vscode-languageserver/node';
import { ResponseError } from 'vscode-languageserver/node';
import { wordPatterns } from './completion';
import { getWordRange } from '@volar/shared';
import { TsMappingData } from '../utils/sourceMaps';

export function register({ sourceFiles, mapper, getCssLs, getTsLs, scriptTsLs }: ApiLanguageServiceContext) {

	return {
		prepareRename: (uri: string, position: Position) => {

			const tsResult = onTsPrepare(uri, position);
			if (tsResult) {
				return tsResult;
			}

			const cssResult = onCssPrepare(uri, position);
			if (cssResult) {
				return cssResult;
			}
		},
		doRename: (uri: string, position: Position, newName: string) => {

			const tsResult = onTs(uri, position, newName);
			if (tsResult) {
				doDedupe(tsResult);
				return tsResult;
			}

			const cssResult = onCss(uri, position, newName);
			if (cssResult) {
				doDedupe(cssResult);
				return cssResult;
			}

			function doDedupe(workspaceEdit: WorkspaceEdit) {
				if (workspaceEdit.changes) {
					for (const uri in workspaceEdit.changes) {
						workspaceEdit.changes[uri] = dedupe.withTextEdits(workspaceEdit.changes[uri]);
					}
				}
			}
		},
		onRenameFile: onTsFile,
	}

	function onTsPrepare(uri: string, position: Position) {
		for (const tsRange of mapper.ts.to(uri, position)) {
			if (
				tsRange.data.capabilities.rename === true
				|| (typeof tsRange.data.capabilities.rename === 'object' && tsRange.data.capabilities.rename.in)
			) {
				const tsPrepare = tsRange.languageService.prepareRename(
					tsRange.textDocument.uri,
					tsRange.range.start,
				);
				if (!tsPrepare)
					continue;

				if (tsPrepare instanceof ResponseError)
					return tsPrepare;

				for (const vueRange of mapper.ts.from(tsRange.textDocument.uri, tsPrepare.start, tsPrepare.end))
					return vueRange.range;
			}
		}
	}
	function onTsScriptPrepareWorker(tsUri: string, ) {
		const tsLs = getTsLs('script');
	}
	function onTsFile(oldUri: string, newUri: string) {

		const sourceFile = sourceFiles.get(oldUri);
		if (sourceFile) {
			const tsDoc = sourceFile.getScriptLsDoc();
			if (tsDoc) {
				const tsOldUri = tsDoc.uri;
				const tsNewUri = newUri + '.ts';
				const tsResult = scriptTsLs.getEditsForFileRename(tsOldUri, tsNewUri);
				if (tsResult) {
					return tsEditToVueEdit('script', tsResult, mapper, canRename);
				}
			}
		}
		else {
			const tsResult = scriptTsLs.getEditsForFileRename(oldUri, newUri);
			if (tsResult) {
				return tsEditToVueEdit('script', tsResult, mapper, canRename);
			}
		}
	}
	function onTs(uri: string, position: Position, newName: string) {

		const loopChecker = dedupe.createLocationSet();
		const tsResult: WorkspaceEdit = {};
		let hasResult = false;

		// vue -> ts
		for (const tsRange of mapper.ts.to(uri, position)) {
			if (
				tsRange.data.capabilities.rename === true
				|| (typeof tsRange.data.capabilities.rename === 'object' && tsRange.data.capabilities.rename.in)
			) {
				const newName_2 = tsRange.data.beforeRename ? tsRange.data.beforeRename(newName) : newName;
				withTeleports(tsRange.textDocument.uri, tsRange.range.start, newName_2);

				function withTeleports(uri: string, position: Position, newName: string) {

					const tsWorkspaceEdit = tsRange.languageService.doRename(
						uri,
						position,
						newName,
					);

					if (tsWorkspaceEdit) {
						hasResult = true;
						margeWorkspaceEdits(tsResult, tsWorkspaceEdit);
					}

					if (tsWorkspaceEdit?.changes) {
						for (const editUri in tsWorkspaceEdit.changes) {
							const textEdits = tsWorkspaceEdit.changes[editUri];
							for (const textEdit of textEdits) {
								if (
									textEdit.newText !== newName
									&& textEdit.newText.indexOf(':') >= 0
									&& textEdit.newText.split(':')[0] === newName
								) {
									// patching foo => bar: foo
									continue;
								}
								loopChecker.add({ uri: editUri, range: textEdit.range });
								for (const teleRange of mapper.ts.teleports(editUri, textEdit.range.start, textEdit.range.end)) {
									if (!teleRange.sideData.capabilities.rename)
										continue;
									if (loopChecker.has({ uri: editUri, range: teleRange }))
										continue;
									const newName_2 = teleRange.sideData.editRenameText
										? teleRange.sideData.editRenameText(newName)
										: newName;
									withTeleports(editUri, teleRange.start, newName_2);
								}
							}
						}
					}
				}
			}
		}

		if (!hasResult)
			return;

		// ts -> vue
		const vueResult = tsEditToVueEdit(tsResult, mapper, canRename);
		return vueResult;
	}
	function onCssPrepare(uri: string, position: Position) {
		for (const cssRange of mapper.css.to(uri, position)) {
			const wordPattern = wordPatterns[cssRange.textDocument.languageId] ?? wordPatterns.css;
			const wordRange = getWordRange(wordPattern, cssRange.range.end, cssRange.textDocument);
			if (wordRange) {
				for (const vueRange of mapper.css.from(cssRange.textDocument.uri, wordRange.start, wordRange.end)) {
					return vueRange.range;
				}
			}
		}
	}
	function onCss(uri: string, position: Position, newName: string) {

		const cssResult: WorkspaceEdit = { changes: {} };
		const vueResult: WorkspaceEdit = { changes: {} };
		let hasResult = false;

		// vue -> css
		for (const cssRange of mapper.css.to(uri, position)) {
			const cssLs = getCssLs(cssRange.textDocument.languageId);
			if (!cssLs) continue;
			const cssWorkspaceEdit = cssLs.doRename(
				cssRange.textDocument,
				cssRange.range.start,
				newName,
				cssRange.stylesheet,
			);
			if (cssWorkspaceEdit) {
				hasResult = true;
				margeWorkspaceEdits(cssResult, cssWorkspaceEdit);
			}
		}

		if (!hasResult)
			return;

		// css -> vue
		for (const cssUri in cssResult.changes) {
			const cssEdits = cssResult.changes[cssUri];
			for (const cssEdit of cssEdits) {
				for (const vueRange of mapper.css.from(cssUri, cssEdit.range.start, cssEdit.range.end)) {
					if (!vueResult.changes) {
						vueResult.changes = {};
					}
					if (!vueResult.changes[vueRange.textDocument.uri]) {
						vueResult.changes[vueRange.textDocument.uri] = [];
					}
					vueResult.changes[vueRange.textDocument.uri].push({
						newText: cssEdit.newText,
						range: vueRange.range,
					});
				}
			}
		}

		return vueResult;
	}
}

function canRename(data?: TsMappingData) {
	return !data
		|| data.capabilities.rename === true
		|| (typeof data.capabilities.rename === 'object' && data.capabilities.rename.out)
}
export function margeWorkspaceEdits(original: WorkspaceEdit, ...others: WorkspaceEdit[]) {
	for (const other of others) {
		for (const uri in other.changeAnnotations) {
			if (!original.changeAnnotations) {
				original.changeAnnotations = {};
			}
			original.changeAnnotations[uri] = other.changeAnnotations[uri];
		}
		for (const uri in other.changes) {
			if (!original.changes) {
				original.changes = {};
			}
			if (!original.changes[uri]) {
				original.changes[uri] = [];
			}
			const edits = other.changes[uri];
			original.changes[uri] = original.changes[uri].concat(edits);
		}
		if (other.documentChanges) {
			if (!original.documentChanges) {
				original.documentChanges = [];
			}
			for (const docChange of other.documentChanges) {
				original.documentChanges.push(docChange);
			}
		}
	}
}
export function tsEditToVueEdit(lsType: 'template' | 'script', tsResult: WorkspaceEdit, mapper: ApiLanguageServiceContext['mapper'], isValidRange: (data?: TsMappingData) => boolean) {
	const vueResult: WorkspaceEdit = {};
	let hasResult = false;

	for (const tsUri in tsResult.changeAnnotations) {
		const tsAnno = tsResult.changeAnnotations[tsUri];
		const vueDoc = mapper.tsUri.from(tsUri);
		if (!vueDoc)
			continue;

		if (!vueResult.changeAnnotations)
			vueResult.changeAnnotations = {};

		vueResult.changeAnnotations[vueDoc.uri] = tsAnno;
	}
	for (const tsUri in tsResult.changes) {
		const tsEdits = tsResult.changes[tsUri];
		for (const tsEdit of tsEdits) {
			for (const vueRange of mapper.ts.from(lsType, tsUri, tsEdit.range.start, tsEdit.range.end)) {
				if (
					!vueRange.data
					|| vueRange.data.capabilities.rename === true
					|| (typeof vueRange.data.capabilities.rename === 'object' && vueRange.data.capabilities.rename.out)
				) {
					const newText_2 = vueRange.data?.doRename
						? vueRange.data.doRename(vueRange.textDocument.getText(vueRange.range), tsEdit.newText)
						: tsEdit.newText;

					if (!vueResult.changes) {
						vueResult.changes = {};
					}
					if (!vueResult.changes[vueRange.textDocument.uri]) {
						vueResult.changes[vueRange.textDocument.uri] = [];
					}
					vueResult.changes[vueRange.textDocument.uri].push({
						newText: newText_2,
						range: vueRange.range,
					});
					hasResult = true;
				}
			}
		}
	}
	if (tsResult.documentChanges) {
		for (const tsDocEdit of tsResult.documentChanges) {
			if (!vueResult.documentChanges) {
				vueResult.documentChanges = [];
			}
			let vueDocEdit: typeof tsDocEdit | undefined;
			if (TextDocumentEdit.is(tsDocEdit)) {
				const vueDoc = mapper.tsUri.from(tsDocEdit.textDocument.uri);
				if (!vueDoc)
					continue;
				const _vueDocEdit = TextDocumentEdit.create(
					{ uri: vueDoc.uri, version: vueDoc.version },
					[],
				);
				for (const tsEdit of tsDocEdit.edits) {
					for (const vueRange of mapper.ts.from(lsType, tsDocEdit.textDocument.uri, tsEdit.range.start, tsEdit.range.end)) {
						if (isValidRange(vueRange.data)) {
							_vueDocEdit.edits.push({
								annotationId: AnnotatedTextEdit.is(tsEdit.range) ? tsEdit.range.annotationId : undefined,
								newText: tsEdit.newText,
								range: vueRange.range,
							});
						}
					}
				}
				if (_vueDocEdit.edits.length) {
					vueDocEdit = _vueDocEdit;
				}
			}
			else if (CreateFile.is(tsDocEdit)) {
				const vueDoc = mapper.tsUri.from(tsDocEdit.uri);
				if (!vueDoc)
					continue;
				vueDocEdit = CreateFile.create(vueDoc.uri, tsDocEdit.options, tsDocEdit.annotationId);
			}
			else if (RenameFile.is(tsDocEdit)) {
				const vueDoc = mapper.tsUri.from(tsDocEdit.oldUri);
				if (!vueDoc)
					continue;
				vueDocEdit = RenameFile.create(vueDoc.uri, tsDocEdit.newUri, tsDocEdit.options, tsDocEdit.annotationId);
			}
			else if (DeleteFile.is(tsDocEdit)) {
				const vueDoc = mapper.tsUri.from(tsDocEdit.uri);
				if (!vueDoc)
					continue;
				vueDocEdit = DeleteFile.create(vueDoc.uri, tsDocEdit.options, tsDocEdit.annotationId);
			}
			if (vueDocEdit) {
				vueResult.documentChanges.push(vueDocEdit);
				hasResult = true;
			}
		}
	}
	if (hasResult) {
		return vueResult;
	}
}

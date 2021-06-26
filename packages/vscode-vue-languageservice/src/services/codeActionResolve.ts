import type { ApiLanguageServiceContext } from '../types';
import type { CodeAction } from 'vscode-languageserver-types';
import type { TsCodeActionData } from './codeAction';
import { tsEditToVueEdit } from './rename';

export function register({ getTsLs, mapper }: ApiLanguageServiceContext) {
	return (codeAction: CodeAction) => {
		const data = codeAction.data as TsCodeActionData;
		codeAction = getTsLs(data.lsType).doCodeActionResolve(codeAction);
		if (codeAction.edit) {
			codeAction.edit = tsEditToVueEdit(codeAction.edit, mapper, () => true);
		}
		return codeAction;
	}
}

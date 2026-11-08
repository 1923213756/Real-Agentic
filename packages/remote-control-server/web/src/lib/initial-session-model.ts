import type { PendingModelSelection } from '../shell/createSession'
import type { ProviderModelCatalog } from '../types'
import type { ControlRequestResult } from './rcs-chat-adapter'
import { buildSessionModelOptions } from './session-model-options'

/** The caller must await this before sending the first user message. */
export async function applyInitialSessionModel(
  selection: PendingModelSelection,
  loadCatalog: () => Promise<ProviderModelCatalog>,
  activate: (
    input: PendingModelSelection & { providerConfigRevision: number },
  ) => Promise<ControlRequestResult>,
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const catalog = await loadCatalog()
    const selectable =
      catalog.features.runtimeSwitch &&
      buildSessionModelOptions(catalog).some(
        model =>
          model.providerId === selection.providerId &&
          model.modelProfileId === selection.modelProfileId,
      )
    if (!selectable)
      throw new Error('所选模型当前不可用，请返回模型供应商设置检查')
    const result = await activate({
      ...selection,
      providerConfigRevision: catalog.revision,
    })
    if (!result.ok) {
      if (
        attempt === 0 &&
        (result.error === 'revision_conflict' ||
          result.error === 'provider_revision_conflict')
      )
        continue
      throw new Error(result.error || '模型切换失败，首条消息尚未发送')
    }
    if (
      result.data &&
      typeof result.data === 'object' &&
      (result.data as { deferred?: unknown }).deferred === true
    ) {
      throw new Error('模型切换尚未完成，首条消息尚未发送，请稍后刷新')
    }
    return
  }
}

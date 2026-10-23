/** Typed EMR entry copy; no clinical findings are rendered by this package. */
export const zh = {
  entry: '接入就诊', review: '出院前核查', close: '关闭', start: '开始核查', refresh: '刷新证据',
  hint: '核查结果显示在聊天中，不阻断出院；DRG／DIP 预分组尚未接入',
  newEncounter: '打开另一份就诊', sourceSystem: '来源系统', hospitalCode: '医院编码',
  inpatId: '住院记录 ID', inpatCode: '住院流水号（选填）', open: '打开就诊会话',
  identifiersOnly: '只填写就诊标识。打开会话不会读取病历正文或调用模型',
  opened: '已打开就诊会话', reviewAccepted: '核查已提交，结果会显示在聊天中',
  refreshed: '证据刷新已提交，完成后请重新核查', failed: '操作未完成或结果未确认，请查看会话后重试；出院流程不受影响',
  updateStatus: '更新状态', statusLoading: '正在读取核查状态', revision: '核查版本：', lastKnown: '上次读取的状态',
  statusUnbound: '当前会话未接入就诊，请先打开就诊会话',
  statusDenied: '无权读取当前核查状态，请重新登录或联系管理员',
  statusUnavailable: '暂时无法确认核查状态，请更新状态后再查看；这不代表核查失败',
  statusUnknown: '核查状态是否保存尚未确认，请联系管理员核对后再重试',
  statusBound: '已接入就诊，尚未核查', statusCollecting: '正在读取核查证据', statusReviewing: '正在核查，尚未提交报告',
  statusReviewed: '核查报告已生成，待人工确认', statusNoReport: '尚无已提交报告',
  statusStale: '证据或报告已失效，请重新核查', statusFailed: '核查未完成，请查看会话后重新核查',
  statusCancelled: '核查已取消，可重新核查', statusNotSubmitted: '模型已结束，但未提交核查报告，请查看会话后重新核查',
  statusMaxTokens: '模型达到输出长度上限，未提交核查报告，请查看会话后重新核查',
} satisfies Record<string, string>
/** Locale keys shared by both dictionaries. */
export type EntryKey = keyof typeof zh
/** English dictionary with the same keys. */
export const en = {
  entry: 'Connect encounter', review: 'Pre-discharge review', close: 'Close', start: 'Start review', refresh: 'Refresh evidence',
  hint: 'Findings appear in chat and do not block discharge. DRG/DIP grouping is unavailable.',
  newEncounter: 'Open another encounter', sourceSystem: 'Source system', hospitalCode: 'Hospital code',
  inpatId: 'Inpatient record ID', inpatCode: 'Admission number (optional)', open: 'Open encounter chat',
  identifiersOnly: 'Enter identifiers only. Opening a chat reads no clinical text and makes no model request.',
  opened: 'Encounter chat opened', reviewAccepted: 'Review accepted. Findings will appear in chat.',
  refreshed: 'Evidence refresh accepted. Review again when it finishes.', failed: 'Check the chat before retrying this unconfirmed operation; discharge is unaffected.',
  updateStatus: 'Update status', statusLoading: 'Reading review status', revision: 'Review revision: ', lastKnown: 'Last retrieved status',
  statusUnbound: 'This chat has no connected encounter. Open an encounter chat first.',
  statusDenied: 'Review status access was denied. Sign in again or contact the operator.',
  statusUnavailable: 'Review status could not be confirmed. Update status to check again; this does not mean the review failed.',
  statusUnknown: 'Review persistence is unconfirmed. Ask the operator to reconcile it before retrying.',
  statusBound: 'Encounter connected; no review started', statusCollecting: 'Reading review evidence', statusReviewing: 'Review in progress; no report submitted yet',
  statusReviewed: 'Report generated; human review required', statusNoReport: 'No submitted report',
  statusStale: 'Evidence or report is out of date. Start a new review.', statusFailed: 'Review incomplete. Check the chat before retrying.',
  statusCancelled: 'Review cancelled. A new review can be started.', statusNotSubmitted: 'The model stopped without submitting a report. Check the chat before retrying.',
  statusMaxTokens: 'The model reached its output limit without submitting a report. Check the chat before retrying.',
} satisfies Record<EntryKey, string>

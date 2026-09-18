// 角色、材料槽位与用途目录。槽位是“逻辑材料”，同一槽位的多次上传形成版本链。

export const ROLES = Object.freeze({
  APPLICANT: 'applicant', // 申请人（学生本人）
  AGENT: 'agent',         // 家长代理/监护人
  REVIEWER: 'reviewer',   // 审核员
  ADMIN: 'admin',         // 管理员（授权管理、核账）
  BANK: 'bank',           // 银行（回执、退汇结算）
  SCHOOL: 'school',       // 学校（退款通知）
});

// required: always 始终必备；agent 仅在有代理（未成年人必然有监护人代理）时必备。
// expirable: 上传时必须给 expiresAt；过期版本不能被当作“当前有效版本”。
// amountBearing: 可携带学校账单金额，用于金额变化核对。
export const DOC_SLOTS = Object.freeze({
  admission_letter: { label: '录取通知书', required: 'always' },
  tuition_notice: { label: '学费缴纳通知单', required: 'always', amountBearing: true },
  income_proof: { label: '收入/存款证明', required: 'always', expirable: true },
  passport: { label: '学生证件（护照等）', required: 'always' },
  fx_application: { label: '购汇申请书', required: 'always' },
  authorization_letter: { label: '代办授权书', required: 'agent', expirable: true },
  agent_id: { label: '代理人身份证件', required: 'agent' },
});

export const PURPOSES = Object.freeze({
  TUITION: 'tuition',
  ACCOMMODATION: 'accommodation',
  DEPOSIT: 'deposit',
});

export function requiredSlots(usesAgent) {
  return Object.entries(DOC_SLOTS)
    .filter(([, def]) => def.required === 'always' || (usesAgent && def.required === 'agent'))
    .map(([slot]) => slot);
}

// 年度便利化额度（美元等值），可由环境变量覆盖。
export const DEFAULT_QUOTA_LIMIT_USD = 50_000;
export const QUOTA_CURRENCY = 'USD';

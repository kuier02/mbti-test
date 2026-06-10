/**
 * MBTI 测评系统 - Node.js 一体化服务
 * 托管测试页面 + 代理飞书 API（解决跨域问题）
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

// 飞书配置
const APP_ID = 'cli_aa9799f4abfb9bd8';
const APP_SECRET = '93TOHe8RJcwCRMmYdP8InhsEsEXeqNV6';

// 员工表
const EMPLOYEE_APP_TOKEN = 'Ixv9bL4HkasDCcsYCfnc2MLwnnh';
const EMPLOYEE_TABLE_ID = 'tbl98yqaWVZeQXYT';

// 候选人表
const CANDIDATE_APP_TOKEN = 'ZiMBb9frWaMEDksjdPJc7XJon6c';
const CANDIDATE_TABLE_ID = 'tblydHPeSm9BzI3U';

const PORT = process.env.PORT || 3001;

// 缓存 token
let cachedToken = null;
let tokenExpireAt = 0;

function getTenantToken() {
  return new Promise((resolve, reject) => {
    if (cachedToken && Date.now() < tokenExpireAt) {
      return resolve(cachedToken);
    }

    const body = JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET });
    const req = https.request({
      hostname: 'open.feishu.cn',
      path: '/open-apis/auth/v3/tenant_access_token/internal',
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          cachedToken = result.tenant_access_token;
          tokenExpireAt = Date.now() + (result.expire - 300) * 1000;
          resolve(cachedToken);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function proxyFeishu(method, apiPath, reqBody, extraHeaders) {
  return new Promise((resolve, reject) => {
    const headers = Object.assign(
      { 'Content-Type': 'application/json; charset=utf-8' },
      extraHeaders || {}
    );
    const options = {
      hostname: 'open.feishu.cn',
      path: apiPath,
      method: method,
      headers: headers
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ code: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          resolve({ code: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    if (reqBody) req.write(reqBody);
    req.end();
  });
}

async function writeToFeishu(recordData, appToken, tableId) {
  const token = await getTenantToken();
  const fields = {};

  for (const [key, value] of Object.entries(recordData)) {
    if (['E分值', 'I分值', 'S分值', 'N分值', 'T分值', 'F分值', 'J分值', 'P分值'].includes(key)) {
      fields[key] = parseInt(value) || 0;
    } else {
      fields[key] = String(value || '');
    }
  }

  const body = JSON.stringify({ fields });
  const result = await proxyFeishu(
    'POST',
    `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`,
    body,
    { 'Authorization': `Bearer ${token}` }
  );

  if (result.code === 200 && result.body.code === 0) {
    return {
      success: true,
      msg: '已成功提交到飞书智能表格！',
      record_id: result.body.data?.record?.record_id
    };
  } else {
    const errMsg = result.body?.msg || result.body?.error?.msg || '未知错误';
    throw new Error(errMsg);
  }
}

// ============================================================
// MBTI 人岗匹配分析系统
// ============================================================

// 16种MBTI类型的详细特征描述
const MBTI_PROFILES = {
  'ISTJ': { name: '物流师', traits: ['可靠稳定', '注重细节', '逻辑清晰', '责任感强', '按章办事'], workStyle: '偏好结构化、有序的工作环境，重视规则和流程', leadership: '稳健型领导，注重执行和规范', teamRole: '团队中的执行者和质量把关者', pressure: '压力下更加遵循规则，需要明确的方向' },
  'ISFJ': { name: '守卫者', traits: ['细心体贴', '忠诚可靠', '务实耐心', '服务意识强', '善于记忆细节'], workStyle: '偏好和谐稳定的环境，重视他人需求', leadership: '关怀型领导，注重团队成员感受', teamRole: '团队中的支持者和协调者', pressure: '压力下可能过度承担，需要被认可' },
  'INFJ': { name: '提倡者', traits: ['富有远见', '洞察力强', '理想主义', '有使命感', '善解人意'], workStyle: '偏好有意义的工作，追求深度和影响力', leadership: '启发型领导，以愿景驱动团队', teamRole: '团队中的战略家和愿景规划者', pressure: '压力下可能过度内省，需要独处恢复' },
  'INTJ': { name: '建筑师', traits: ['战略思维', '独立自主', '追求卓越', '系统规划', '果断决策'], workStyle: '偏好自主独立的工作，追求效率和最优解', leadership: '战略型领导，以目标为导向', teamRole: '团队中的架构师和方向制定者', pressure: '压力下更加独立决断，需要尊重其空间' },
  'ISTP': { name: '鉴赏家', traits: ['灵活务实', '动手能力强', '冷静分析', '适应力强', '问题解决者'], workStyle: '偏好灵活自主的环境，享受解决实际问题', leadership: '务实型领导，以身作则', teamRole: '团队中的技术专家和问题解决者', pressure: '压力下保持冷静，偏好独立行动' },
  'ISFP': { name: '探险家', traits: ['温和敏感', '审美独到', '随和自然', '重视和谐', '活在当下'], workStyle: '偏好自由创意的环境，重视个人价值观', leadership: '温和型领导，以榜样带动', teamRole: '团队中的创意贡献者和氛围调节者', pressure: '压力下可能退缩，需要空间和尊重' },
  'INFP': { name: '调停者', traits: ['理想主义', '创造力强', '共情能力强', '追求意义', '价值驱动'], workStyle: '偏好有创造空间和意义感的工作', leadership: '激励型领导，以价值观凝聚团队', teamRole: '团队中的创意者和价值观守护者', pressure: '压力下可能情绪化，需要理解和支持' },
  'INTP': { name: '逻辑学家', traits: ['逻辑缜密', '好奇求知', '创新思维', '独立思考', '理论建构'], workStyle: '偏好智力挑战和自主探索的空间', leadership: '理念型领导，以逻辑说服团队', teamRole: '团队中的理论家和方案设计者', pressure: '压力下更加理性分析，可能忽视情感' },
  'ESTP': { name: '企业家', traits: ['行动导向', '适应力强', '善于社交', '风险承受', '实战经验'], workStyle: '偏好快节奏、有挑战性的环境', leadership: '行动型领导，冲锋在前', teamRole: '团队中的行动者和危机处理者', pressure: '压力下更加果断行动，享受挑战' },
  'ESFP': { name: '表演者', traits: ['热情洋溢', '社交达人', '乐观积极', '活在当下', '善于激励'], workStyle: '偏好活跃互动、充满活力的环境', leadership: '感染型领导，以热情带动团队', teamRole: '团队中的氛围担当和资源连接者', pressure: '压力下寻求社交支持，保持乐观' },
  'ENFP': { name: '竞选者', traits: ['创意无限', '热情感染', '善于激励', '灵活变通', '人际洞察'], workStyle: '偏好创新多元、有人际互动的空间', leadership: '魅力型领导，以热情感染团队', teamRole: '团队中的创意引擎和人际连接者', pressure: '压力下可能分散注意力，需要聚焦提醒' },
  'ENTP': { name: '辩论家', traits: ['思维敏捷', '善于辩论', '创新突破', '挑战常规', '多面手'], workStyle: '偏好充满智力挑战和变化的环境', leadership: '挑战型领导，以创新推动变革', teamRole: '团队中的创新者和破局者', pressure: '压力下激发更多创意，可能忽视细节' },
  'ESTJ': { name: '总经理', traits: ['组织高效', '决策果断', '注重执行', '规则意识', '结果导向'], workStyle: '偏好有序可控、目标明确的环境', leadership: '指令型领导，以效率驱动团队', teamRole: '团队中的组织者和执行保障者', pressure: '压力下更加掌控全局，需要快速决断' },
  'ESFJ': { name: '执政官', traits: ['热心助人', '组织有序', '重视和谐', '团队意识', '传统价值'], workStyle: '偏好合作融洽、服务他人的环境', leadership: '服务型领导，以关怀凝聚团队', teamRole: '团队中的协调者和人际维护者', pressure: '压力下更加关注他人，需要被需要感' },
  'ENFJ': { name: '主人公', traits: ['魅力领导', '善于激励', '洞察人心', '组织能力', '使命感强'], workStyle: '偏好有影响力、能帮助他人成长的环境', leadership: '赋能型领导，以愿景激励团队', teamRole: '团队中的领导者和人才发展者', pressure: '压力下可能过度承担，需要自我关注' },
  'ENTJ': { name: '指挥官', traits: ['战略远见', '果断决策', '效率至上', '天生领导', '目标驱动'], workStyle: '偏好高效运转、有挑战和晋升空间的环境', leadership: '统帅型领导，以战略驱动团队', teamRole: '团队中的决策者和战略规划者', pressure: '压力下更加果断高效，可能显得强势' }
};

// 岗位类别关键词映射
const JOB_CATEGORIES = {
  '技术开发': {
    keywords: ['开发', '程序', '工程师', '技术', '前端', '后端', '全栈', '软件', '算法', '数据', '运维', '测试', '架构', 'IT', '计算机', '代码', '研发', '编程', 'AI', '人工智能', '机器学习', '深度学习'],
    suitedTypes: ['INTJ', 'INTP', 'ISTJ', 'ISTP', 'INFJ'],
    dimWeights: { I: 0.8, N: 0.7, T: 0.9, J: 0.5, P: 0.5 },
    desc: '技术开发岗位需要逻辑思维、专注力和问题解决能力'
  },
  '产品设计': {
    keywords: ['产品', '设计', 'UI', 'UX', '交互', '视觉', '体验', '设计师', '创意', '原画', '美工', '平面'],
    suitedTypes: ['INFP', 'ENFP', 'INFJ', 'ISFP', 'INTP'],
    dimWeights: { N: 0.8, F: 0.6, P: 0.7 },
    desc: '产品设计岗位需要创造力、用户同理心和创新思维'
  },
  '市场营销': {
    keywords: ['市场', '营销', '推广', '品牌', '公关', '策划', '广告', '运营', '增长', '商务', 'BD', 'sem', 'seo', '新媒体'],
    suitedTypes: ['ENFP', 'ENTP', 'ESTP', 'ESFP', 'ENFJ'],
    dimWeights: { E: 0.8, N: 0.6, F: 0.5, P: 0.6 },
    desc: '市场营销岗位需要社交能力、创意思维和应变能力'
  },
  '销售业务': {
    keywords: ['销售', '业务', '客户', '商务拓展', '客户经理', 'KA', '大客户', '渠道', '招商'],
    suitedTypes: ['ESTP', 'ESFP', 'ENTJ', 'ENFJ', 'ESTJ'],
    dimWeights: { E: 0.9, S: 0.5, T: 0.4, J: 0.5 },
    desc: '销售业务岗位需要人际影响力、抗压能力和目标驱动力'
  },
  '人力资源': {
    keywords: ['人力', 'HR', '招聘', '培训', '薪酬', '绩效', '员工关系', '组织发展', 'OD', '政委', 'HRBP'],
    suitedTypes: ['ENFJ', 'ESFJ', 'INFJ', 'ISFJ', 'ENTJ'],
    dimWeights: { F: 0.8, J: 0.7, E: 0.6, N: 0.4 },
    desc: '人力资源岗位需要人际洞察、组织协调和情感智慧'
  },
  '财务会计': {
    keywords: ['财务', '会计', '审计', '税务', '出纳', '风控', '金融', '投资', '证券', '银行', '保险'],
    suitedTypes: ['ISTJ', 'ISFJ', 'ESTJ', 'INTJ', 'ENTJ'],
    dimWeights: { S: 0.7, T: 0.8, J: 0.9 },
    desc: '财务会计岗位需要严谨细致、逻辑分析和规范意识'
  },
  '行政管理': {
    keywords: ['行政', '秘书', '助理', '前台', '文秘', '后勤', '办公', '总务'],
    suitedTypes: ['ISFJ', 'ESFJ', 'ISTJ', 'ESTJ'],
    dimWeights: { S: 0.6, J: 0.8, F: 0.5 },
    desc: '行政管理岗位需要细心有序、服务意识和协调能力'
  },
  '项目管理': {
    keywords: ['项目', 'PM', '管理', '协调', 'Scrum', '敏捷', '交付', '实施', '项目经理'],
    suitedTypes: ['ENTJ', 'ESTJ', 'INTJ', 'ENFJ', 'ISTJ'],
    dimWeights: { J: 0.8, T: 0.6, E: 0.5, N: 0.4 },
    desc: '项目管理岗位需要组织能力、目标导向和决策力'
  },
  '教育咨询': {
    keywords: ['教师', '讲师', '培训', '教育', '咨询', '顾问', '辅导', '课程', '教学', '心理'],
    suitedTypes: ['ENFJ', 'INFJ', 'ESFJ', 'ENFP', 'ISFJ'],
    dimWeights: { F: 0.7, N: 0.5, J: 0.5, E: 0.6 },
    desc: '教育咨询岗位需要表达能力、共情心和引导能力'
  },
  '法律合规': {
    keywords: ['法律', '律师', '法务', '合规', '知识产权', '专利', '合同', '风控法务'],
    suitedTypes: ['ISTJ', 'INTJ', 'ESTJ', 'INFJ', 'INTP'],
    dimWeights: { T: 0.8, J: 0.8, S: 0.6, I: 0.5 },
    desc: '法律合规岗位需要逻辑严密、注重细节和规则意识'
  },
  '运营管理': {
    keywords: ['运营', '店长', '主管', '经理', '总监', '负责人', '领班', '工厂', '生产', '供应链', '物流', '仓储'],
    suitedTypes: ['ESTJ', 'ENTJ', 'ISTJ', 'ESFJ', 'ENFJ'],
    dimWeights: { J: 0.8, S: 0.5, T: 0.5, E: 0.6 },
    desc: '运营管理岗位需要组织协调、执行力和结果导向'
  },
  '内容创作': {
    keywords: ['编辑', '文案', '写作', '记者', '作者', '编剧', '自媒体', '内容', '编导', '策划'],
    suitedTypes: ['INFP', 'ENFP', 'INFJ', 'INTP', 'ISFP'],
    dimWeights: { N: 0.8, F: 0.5, P: 0.6, I: 0.4 },
    desc: '内容创作岗位需要创造力、表达力和深度思考'
  }
};

// 维度偏好名称映射
const DIM_NAMES = {
  E: '外向', I: '内向',
  S: '实感', N: '直觉',
  T: '思考', F: '情感',
  J: '判断', P: '感知'
};

/**
 * 识别人岗匹配分析
 * @param {string} mbtiType - MBTI类型，如 "ISTJ"
 * @param {string} jobTitle - 求职岗位
 * @param {object} scores - 各维度分值 {E:70, I:30, S:60, N:40, T:55, F:45, J:65, P:35}
 * @returns {string} 详细的分析文本
 */
function generateJobMatchAnalysis(mbtiType, jobTitle, scores) {
  const profile = MBTI_PROFILES[mbtiType];
  if (!profile) return '无法识别的MBTI类型，暂无法生成匹配分析。';

  const job = (jobTitle || '').trim();
  if (!job) return `候选人MBTI类型为${mbtiType}(${profile.name})，但未填写求职岗位，无法进行人岗匹配分析。`;

  // 1. 识别岗位类别
  let matchedCategory = null;
  let matchedScore = 0;
  for (const [catName, catData] of Object.entries(JOB_CATEGORIES)) {
    const hitCount = catData.keywords.filter(kw => job.includes(kw)).length;
    if (hitCount > matchedScore) {
      matchedScore = hitCount;
      matchedCategory = { name: catName, ...catData };
    }
  }

  // 如果没有匹配到具体类别，使用通用分析
  if (!matchedCategory) {
    return generateGenericAnalysis(mbtiType, profile, job, scores);
  }

  // 2. 计算匹配度
  const isTypeSuited = matchedCategory.suitedTypes.includes(mbtiType);

  // 维度匹配分析
  const dimAnalysis = [];
  const weights = matchedCategory.dimWeights;

  // E/I维度
  if (weights.E || weights.I) {
    const dominant = scores.E >= scores.I ? 'E' : 'I';
    const preferred = weights.E ? 'E' : 'I';
    const match = dominant === preferred;
    dimAnalysis.push({
      dimension: '能量方向',
      detail: match
        ? `候选人${dominant}倾向(${DIM_NAMES[dominant]}, ${scores[dominant]}%)与岗位偏好${DIM_NAMES[preferred]}方向一致，${DIM_NAMES[dominant]}特质有助于该岗位的工作开展。`
        : `候选人${dominant}倾向(${DIM_NAMES[dominant]}, ${scores[dominant]}%)与岗位偏好的${DIM_NAMES[preferred]}方向有所不同，${DIM_NAMES[dominant]}特质在该岗位中可能需要额外适应。`,
      match
    });
  }

  // S/N维度
  if (weights.S || weights.N) {
    const dominant = scores.S >= scores.N ? 'S' : 'N';
    const preferred = weights.S ? 'S' : 'N';
    const match = dominant === preferred;
    dimAnalysis.push({
      dimension: '信息获取',
      detail: match
        ? `候选人${dominant}倾向(${DIM_NAMES[dominant]}, ${scores[dominant]}%)与岗位偏好${DIM_NAMES[preferred]}方式一致，有利于信息的有效处理。`
        : `候选人${dominant}倾向(${DIM_NAMES[dominant]}, ${scores[dominant]}%)与岗位偏好的${DIM_NAMES[preferred]}方式有差异，可能需要在工作方式上做调整。`,
      match
    });
  }

  // T/F维度
  if (weights.T || weights.F) {
    const dominant = scores.T >= scores.F ? 'T' : 'F';
    const preferred = weights.T ? 'T' : 'F';
    const match = dominant === preferred;
    dimAnalysis.push({
      dimension: '决策方式',
      detail: match
        ? `候选人${dominant}倾向(${DIM_NAMES[dominant]}, ${scores[dominant]}%)与岗位偏好的${DIM_NAMES[preferred]}决策方式一致，决策风格与岗位需求契合。`
        : `候选人${dominant}倾向(${DIM_NAMES[dominant]}, ${scores[dominant]}%)与岗位偏好的${DIM_NAMES[preferred]}决策方式不同，在决策过程中可能需要关注另一维度的考量。`,
      match
    });
  }

  // J/P维度
  if (weights.J || weights.P) {
    const dominant = scores.J >= scores.P ? 'J' : 'P';
    const preferred = weights.J ? 'J' : 'P';
    const match = dominant === preferred;
    dimAnalysis.push({
      dimension: '工作方式',
      detail: match
        ? `候选人${dominant}倾向(${DIM_NAMES[dominant]}, ${scores[dominant]}%)与岗位偏好的${DIM_NAMES[preferred]}工作方式一致，工作节奏与岗位匹配。`
        : `候选人${dominant}倾向(${DIM_NAMES[dominant]}, ${scores[dominant]}%)与岗位偏好的${DIM_NAMES[preferred]}工作方式有差异，可能需要调整工作节奏以适应岗位需求。`,
      match
    });
  }

  const matchCount = dimAnalysis.filter(d => d.match).length;
  const totalDims = dimAnalysis.length;
  const matchRate = totalDims > 0 ? matchCount / totalDims : 0;

  // 3. 综合匹配等级
  let matchLevel, matchLabel, matchEmoji;
  if (isTypeSuited && matchRate >= 0.75) {
    matchLevel = 'A'; matchLabel = '高度匹配'; matchEmoji = '🟢';
  } else if (isTypeSuited && matchRate >= 0.5) {
    matchLevel = 'B+'; matchLabel = '较好匹配'; matchEmoji = '🔵';
  } else if (isTypeSuited || matchRate >= 0.75) {
    matchLevel = 'B'; matchLabel = '中度匹配'; matchEmoji = '🟡';
  } else if (matchRate >= 0.5) {
    matchLevel = 'C+'; matchLabel = '一般匹配'; matchEmoji = '🟠';
  } else {
    matchLevel = 'C'; matchLabel = '待评估匹配'; matchEmoji = '🔴';
  }

  // 4. 生成挑战分析
  const challenges = [];
  dimAnalysis.forEach(d => {
    if (!d.match) {
      challenges.push(d.dimension + '维度存在差异，需要针对性适应');
    }
  });

  // 5. 给出发展建议
  const suggestions = [];
  dimAnalysis.filter(d => !d.match).forEach(d => {
    const dim = d.dimension;
    if (dim === '能量方向') suggestions.push('可尝试在需要时调整社交节奏，保持适当的沟通频率和深度');
    if (dim === '信息获取') suggestions.push('练习从不同角度获取信息，兼顾细节把控和全局视野');
    if (dim === '决策方式') suggestions.push('在决策时同时考虑逻辑分析和人文关怀，做到理性与感性平衡');
    if (dim === '工作方式') suggestions.push('根据任务需要灵活调整计划性和开放性，既要有目标感也要保持灵活');
  });

  if (suggestions.length === 0) {
    suggestions.push('当前性格特质与岗位高度匹配，建议持续发挥优势，关注职业成长');
    suggestions.push('可以在团队协作中承担更多跨职能角色，拓宽职业发展路径');
  }

  // 6. 组装完整分析文本
  let analysis = '';
  analysis += `${matchEmoji} 匹配等级：${matchLevel}（${matchLabel}）\n\n`;
  analysis += `━━━ 基本画像 ━━━\n`;
  analysis += `MBTI类型：${mbtiType}（${profile.name}）\n`;
  analysis += `求职岗位：${job}\n`;
  analysis += `岗位类别：${matchedCategory.name}\n`;
  analysis += `岗位特征：${matchedCategory.desc}\n\n`;

  analysis += `━━━ 性格优势 ━━━\n`;
  profile.traits.forEach((t, i) => {
    analysis += `${i + 1}. ${t}\n`;
  });
  analysis += `\n`;

  analysis += `━━━ 维度分析 ━━━\n`;
  dimAnalysis.forEach((d, i) => {
    analysis += `${i + 1}. 【${d.dimension}】${d.match ? '✅' : '⚠️'} ${d.detail}\n`;
  });
  analysis += `\n`;

  analysis += `━━━ 工作风格 ━━━\n`;
  analysis += `工作偏好：${profile.workStyle}\n`;
  analysis += `领导风格：${profile.leadership}\n`;
  analysis += `团队角色：${profile.teamRole}\n`;
  analysis += `压力反应：${profile.pressure}\n\n`;

  if (challenges.length > 0) {
    analysis += `━━━ 潜在挑战 ━━━\n`;
    challenges.forEach((c, i) => {
      analysis += `${i + 1}. ${c}\n`;
    });
    analysis += `\n`;
  }

  analysis += `━━━ 发展建议 ━━━\n`;
  suggestions.forEach((s, i) => {
    analysis += `${i + 1}. ${s}\n`;
  });
  analysis += `\n`;

  // 适合该类型的其他岗位方向
  const otherSuitableJobs = [];
  for (const [catN, catD] of Object.entries(JOB_CATEGORIES)) {
    if (catN !== matchedCategory.name && catD.suitedTypes.includes(mbtiType)) {
      otherSuitableJobs.push(catN);
    }
  }
  if (otherSuitableJobs.length > 0) {
    analysis += `━━━ 岗位拓展 ━━━\n`;
    analysis += `基于${mbtiType}性格特质，还可关注以下方向：${otherSuitableJobs.join('、')}\n`;
  }

  return analysis;
}

/**
 * 通用分析（无法匹配到具体岗位类别时使用）
 */
function generateGenericAnalysis(mbtiType, profile, jobTitle, scores) {
  const dominant = {
    EI: scores.E >= scores.I ? 'E' : 'I',
    SN: scores.S >= scores.N ? 'S' : 'N',
    TF: scores.T >= scores.F ? 'T' : 'F',
    JP: scores.J >= scores.P ? 'J' : 'P'
  };

  const dimDescriptions = {
    E: `外向型(${scores.E}%)，善于社交互动，从人际交往中获取能量`,
    I: `内向型(${scores.I}%)，偏好独立思考，从内在世界获取能量`,
    S: `实感型(${scores.S}%)，注重具体事实和细节，偏好经验导向`,
    N: `直觉型(${scores.N}%)，善于把握全局和趋势，偏好创新思维`,
    T: `思考型(${scores.T}%)，以逻辑分析做决策，重视客观标准`,
    F: `情感型(${scores.F}%)，以价值感受做决策，重视人际和谐`,
    J: `判断型(${scores.J}%)，偏好有计划有条理的工作方式`,
    P: `感知型(${scores.P}%)，偏好灵活开放的工作方式`
  };

  // 找出适合的岗位方向
  const suitableJobs = [];
  for (const [catN, catD] of Object.entries(JOB_CATEGORIES)) {
    if (catD.suitedTypes.includes(mbtiType)) {
      suitableJobs.push(catN);
    }
  }

  let analysis = '';
  analysis += `🟡 匹配等级：B（通用评估）\n\n`;
  analysis += `━━━ 基本画像 ━━━\n`;
  analysis += `MBTI类型：${mbtiType}（${profile.name}）\n`;
  analysis += `求职岗位：${jobTitle}（未匹配到标准岗位类别，提供通用分析）\n\n`;

  analysis += `━━━ 性格优势 ━━━\n`;
  profile.traits.forEach((t, i) => {
    analysis += `${i + 1}. ${t}\n`;
  });
  analysis += `\n`;

  analysis += `━━━ 维度详情 ━━━\n`;
  analysis += `• 能量方向：${dimDescriptions[dominant.EI]}\n`;
  analysis += `• 信息获取：${dimDescriptions[dominant.SN]}\n`;
  analysis += `• 决策方式：${dimDescriptions[dominant.TF]}\n`;
  analysis += `• 工作方式：${dimDescriptions[dominant.JP]}\n\n`;

  analysis += `━━━ 工作风格 ━━━\n`;
  analysis += `工作偏好：${profile.workStyle}\n`;
  analysis += `领导风格：${profile.leadership}\n`;
  analysis += `团队角色：${profile.teamRole}\n`;
  analysis += `压力反应：${profile.pressure}\n\n`;

  if (suitableJobs.length > 0) {
    analysis += `━━━ 岗位方向 ━━━\n`;
    analysis += `基于${mbtiType}性格特质，推荐关注以下方向：${suitableJobs.join('、')}\n`;
    analysis += `\n建议结合具体岗位要求，进一步评估匹配度。\n`;
  }

  return analysis;
}


// MIME 类型
const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    return res.end();
  }

  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // API 路由 — 员工
  if (req.method === 'POST' && pathname === '/submit') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const result = await writeToFeishu(data, EMPLOYEE_APP_TOKEN, EMPLOYEE_TABLE_ID);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
        console.log('[员工]', data.姓名, '-', data.人格类型);
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, msg: e.message }));
        console.log('[FAIL-员工]', e.message);
      }
    });
    return;
  }

  // API 路由 — 面试候选人
  if (req.method === 'POST' && pathname === '/submit-candidate') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);

        // 生成人岗匹配分析
        const scores = {
          E: parseInt(data['E分值']) || 0,
          I: parseInt(data['I分值']) || 0,
          S: parseInt(data['S分值']) || 0,
          N: parseInt(data['N分值']) || 0,
          T: parseInt(data['T分值']) || 0,
          F: parseInt(data['F分值']) || 0,
          J: parseInt(data['J分值']) || 0,
          P: parseInt(data['P分值']) || 0
        };
        const jobTitle = data['求职岗位'] || '';
        const mbtiType = data['人格类型'] || '';

        if (mbtiType && jobTitle) {
          data['人岗匹配分析'] = generateJobMatchAnalysis(mbtiType, jobTitle, scores);
        } else if (mbtiType) {
          data['人岗匹配分析'] = generateJobMatchAnalysis(mbtiType, '', scores);
        }

        const result = await writeToFeishu(data, CANDIDATE_APP_TOKEN, CANDIDATE_TABLE_ID);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
        console.log('[候选人]', data.姓名, '-', data.人格类型, '- 匹配分析已生成');
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, msg: e.message }));
        console.log('[FAIL-候选人]', e.message);
      }
    });
    return;
  }

  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ status: 'ok', service: 'MBTI-Cloud' }));
  }

  // 静态文件服务
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.join(__dirname, filePath);

  // 安全检查
  if (filePath.includes('..')) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  const ext = path.extname(filePath);
  const contentType = MIME[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not Found');
    }
    res.writeHead(200, { 'Content-Type': `${contentType}; charset=utf-8` });
    res.end(content);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('MBTI Cloud Service running on port', PORT);
});

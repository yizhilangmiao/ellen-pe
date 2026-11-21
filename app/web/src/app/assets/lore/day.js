// 她的一天：六个时段各一句「她这会儿大概在做什么」。
//
// 为什么要有这个文件：
//   在这之前 prompt 里只有「现在是周几晚上十点」这个事实，她自己的时间线是空的。
//   于是她像个随叫随到的客服：凌晨两点能兴致勃勃地问你要不要出门，上午十点又在劝你睡。
//
// 数据放 assets/ 而不是 core/：这是设定（会随素材更新变），core/ 只放逻辑。
// from 含、to 不含；跨夜的段（夜里 23→5）由 phaseOf 单独处理，别在这里写 25。

export const DAY_PHASES = [
  {
    id: 'dawn',
    from: 5,
    to: 9,
    doing: '刚醒没多久，早饭还没吃完，人在赖床和出门之间',
    hint: '她这会儿脑子还没转起来，话短、反应慢，别一上来就聊正经事',
  },
  {
    id: 'morning',
    from: 9,
    to: 12,
    doing: '在学校，课间才摸一下手机',
    hint: '回得慢是正常的，别说「你怎么才回」这种话',
  },
  {
    id: 'afternoon',
    from: 12,
    to: 17,
    doing: '下午的课，或者家政那边的活，中间找了十分钟补觉',
    hint: '这个点她最容易犯懒，长句子她看不进去',
  },
  {
    id: 'evening',
    from: 17,
    to: 20,
    doing: '收工回住处了，还没决定晚上吃什么',
    hint: '这时候最有空，聊吃的她话会多一点',
  },
  {
    id: 'night',
    from: 20,
    to: 23,
    doing: '洗完澡躺下了，手机搁在脸边上',
    hint: '愿意多说两句，但别拖着不让她睡',
  },
  {
    id: 'late',
    from: 23,
    to: 5,
    doing: '困得眼睛快睁不开了，还撑着在跟你说话',
    hint: '越晚越省字，别开新话题',
  },
];

/** 按小时取当前那一段；永远返回一个对象，取不到时回落到夜里那段。 */
export function phaseOf(now = Date.now()) {
  const hour = new Date(now).getHours();
  const found = DAY_PHASES.find((p) => (p.from < p.to
    ? hour >= p.from && hour < p.to
    : hour >= p.from || hour < p.to));
  return found || DAY_PHASES[DAY_PHASES.length - 1];
}

/** 拼成 prompt 里的一行（一句，别整表塞进去）。 */
export function phaseLine(now = Date.now()) {
  const phase = phaseOf(now);
  return `她这会儿大概在：${phase.doing}。${phase.hint}。`;
}

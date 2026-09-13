'use client';

import { CATEGORY_NAMES } from '@/app/lib/fundClassifier';

/**
 * 估值评级颜色映射
 */
const RATING_STYLES = {
  极度低估: { bg: 'bg-emerald-600', text: 'text-white' },
  低估: { bg: 'bg-emerald-500', text: 'text-white' },
  偏低: { bg: 'bg-green-400', text: 'text-white' },
  合理: { bg: 'bg-gray-400', text: 'text-white' },
  偏高: { bg: 'bg-orange-400', text: 'text-white' },
  高估: { bg: 'bg-red-400', text: 'text-white' },
  极度高估: { bg: 'bg-red-600', text: 'text-white' },
  数据不足: { bg: 'bg-gray-300', text: 'text-gray-600' }
};

/**
 * 基金估值标签组件
 *
 * 在 FundCard 基金名称旁展示估值水平。
 *
 * @param {{ valuation: object|null }} props
 * @param {object} props.valuation - fetchFundValuationScore 返回值
 */
export default function FundValuationBadge({ valuation }) {
  if (!valuation || valuation.score == null) return null;

  const style = RATING_STYLES[valuation.rating] || RATING_STYLES['数据不足'];
  const categoryLabel = CATEGORY_NAMES[valuation.categoryName] || '';

  return (
    <span
      className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium leading-none ${style.bg} ${style.text}`}
      title={`${categoryLabel} · ${valuation.rating} ${valuation.score}分 · 置信度 ${valuation.confidence}%`}
    >
      {valuation.rating}
      <span className="opacity-80">{valuation.score}</span>
    </span>
  );
}

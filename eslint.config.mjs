import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import prettierRecommended from 'eslint-plugin-prettier/recommended';

const config = [
  {
    ignores: ['.next/**', 'out/**', 'dist/**', 'coverage/**']
  },
  ...nextCoreWebVitals,
  prettierRecommended,
  {
    rules: {
      'react-hooks/set-state-in-effect': 'off',
      // eslint-config-next 16.4 新增的 React Compiler 规则；存量代码的改造单独跟进，先降级为 warning
      'react-hooks/immutability': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/refs': 'warn',
      'no-debugger': 'error'
    }
  }
];

export default config;

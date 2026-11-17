import os from 'node:os'
import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 测试会写封面、临时脚本等文件：数据目录指到系统临时目录，别碰真实的 data/
    env: { AUTOMEDIA_DATA_DIR: path.join(os.tmpdir(), 'automedia-test-data') },
  },
})

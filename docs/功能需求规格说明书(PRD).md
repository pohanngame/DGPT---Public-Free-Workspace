# common-free 功能需求规格说明书

## 1. 背景与目标

教务系统中的教师课表分散在学院页面和全校总表中，人工对照多位教师的空闲时段成本较高。本项目面向需要排会、排课的教务或组织人员，将教师课表同步到本地 SQLite，并在指定学期和周次内计算公共空闲。

目标如下：

1. 提供可检索、可筛选的教师目录。
2. 支持按学院页面同步课表，并以全校总表补齐未归属学院的教师。
3. 对选定教师返回 7 天 × 6 节的 42 个时段及冲突等级。
4. 允许保存常用教师分组和导入专业信息，减少重复选择。

范围外：不解析 Excel 二进制 `.xlsx` 文件；专业导入使用 `.csv`、`.txt`、`.tsv` 或逗号/Tab 分隔的粘贴文本。

## 2. 角色

| 角色 | 主要任务 |
|---|---|
| 排会/排课人员 | 检索教师、选择分组、查看指定周次的公共空闲 |
| 数据维护人员 | 配置学期周一日期、导入专业信息、发起课表同步 |
| 系统维护人员 | 配置环境变量、运行服务、管理 Docker 和运行数据 |

## 3. 业务流程

### 3.1 查询公共空闲

1. 用户选择学期和周次。
2. 用户按姓名或 `pinyin_initials` 检索教师，可继续按学院或专业筛选。
3. 用户选择教师或载入预设分组。
4. 系统读取本地课表，生成 42 个时段的结果。
5. 用户依据 `FREE`、`ONE_BUSY`、`MANY_BUSY` 及占用详情选择时间。

若学期尚未同步，系统返回 `missingImport`，不把空白结果误显示为可用；不在该学期数据中的选中教师列入 `absentTeachers`。

### 3.2 同步教务课表

1. 维护人员提交学期代码和账号信息。
2. 系统先打开教师页，读取学期及学院信息。
3. 系统按学院逐个拉取课表；当前教务页夹具包含 13 个学院，因此进度为 13+1。
4. 系统再拉取一次全校总表；已在学院结果中出现的教师跳过，只在总表出现的教师归入 `UNAFFILIATED`（未分院系）。
5. 学期数据通过 `replaceSemester` 的 `BEGIN` / `COMMIT` / `ROLLBACK` 事务替换。
6. 前端轮询同步进度，处理完成、失败或滑块挑战。

登录连接 CAS `authserver.dgpt.edu.cn` 和教务 `jw.dgpt.edu.cn`。密码使用页面 salt 做 AES。需要滑块时，界面使用固定 300×150 轨道；提交 `canvasWidth` 为轨道 `clientWidth`，`move` 为拖动距离。

请求账号和密码必须同时非空才使用请求值；否则两个值都从环境变量读取，不能混用。

### 3.3 维护教师附加信息

1. 维护人员准备姓名、学院、专业的逗号或 Tab 分隔文本。
2. 系统接受 `.csv`、`.txt`、`.tsv` 文件内容或直接粘贴的文本。
3. 系统按姓名匹配教师，报告匹配、未匹配和学院不一致的记录。
4. 用户保存设置或创建预设分组，供后续查询使用。

## 4. 功能模块

### 4.1 目录与导入模块

- 学期列表：`GET /api/semesters`
- 学院列表：`GET /api/colleges`
- 教师检索：`GET /api/teachers`
- 专业导入：`POST /api/programs/import`
- 设置读写：`GET/PUT /api/settings`
- 分组读写：`GET/POST /api/presets`、`DELETE /api/presets/:name`

教师支持姓名或 `pinyin_initials` 检索。分组使用 `preset_groups` 与 `preset_group_members`。

### 4.2 公共空闲计算模块

接口：`POST /api/common-free`。

输入包含学期代码、周次和教师姓名列表。周次按 1 至 30 校验。输出固定覆盖星期 1 至 7 和六个节次代码：`0102`、`0304`、`0506`、`0708`、`0910`、`1112`。

每格根据忙碌教师数返回：

| 等级 | 含义 |
|---|---|
| `FREE` | 没有选中教师占用 |
| `ONE_BUSY` | 一位选中教师占用 |
| `MANY_BUSY` | 多位选中教师占用 |

### 4.3 同步与登录模块

- 启动同步：`POST /api/sync/start`
- 提交滑块：`POST /api/sync/slider`
- 查询任务：`GET /api/sync/:jobId`

同步任务状态在进程内维护，密码在登录流程结束或任务失败后清理，不写入数据库。Cookie 仅在教师页真正含有 `xnxqh` 且标题不是登录页时写入 `.jw_cookie_cache.json`，目标文件权限为 `0600`。Cookie 缓存不入数据库、不进 Git。

## 5. SQLite 数据表

| 表 | 字段 | 用途 |
|---|---|---|
| `colleges` | `code`、`name`、`short_code` | 学院目录 |
| `semesters` | `code`、`label`、`is_current` | 学期目录与当前标记 |
| `teachers` | `name`、`pinyin_initials`、`title`、`updated_at` | 教师基本信息 |
| `teacher_colleges` | `teacher_name`、`college_code` | 教师与学院关系 |
| `teacher_programs` | `teacher_name`、`program_name` | 教师专业信息 |
| `occupancies` | `id`、`semester_code`、`teacher_name`、`day_of_week`、`slot_code`、`week_start`、`week_end`、`occupancy_text` | 课表占用 |
| `preset_groups` | `id`、`name`、`created_at` | 预设分组 |
| `preset_group_members` | `group_id`、`teacher_name` | 分组成员 |
| `settings` | `key`、`value` | 应用设置 |
| `semester_teachers` | `semester_code`、`teacher_name`、`college_code` | 学期内教师及归属 |

### 安全边界

- 密码只用于当前同步登录，不进入 SQLite。
- 同步任务状态和临时凭据只在内存中维护，任务结束或失败后清理密码。
- Cookie 缓存是本地文件，不入 SQLite，也不进 Git；部署时应限制文件权限。
- `.env.local`、`.jw_cookie_cache.json` 和运行数据由 `.gitignore` 排除；公开文档只使用占位符。

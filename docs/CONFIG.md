# 配置

插件配置作用于安装它的 DSH profile，树数据默认写入独立目录。

| 字段 | 类型 | 默认值 | 行为 |
| --- | --- | --- | --- |
| `dataDirectory` | string | `${DSH_HOME}/data/dsh-session-tree/sessions` | 插件树文件目录；自定义时建议绝对路径。 |
| `maxRequestBytes` | number | `33554432`（32 MiB） | JSON 请求总字节上限，包括图片 base64；必须是正整数，超限返回 HTTP 413。 |

没有设置 `DSH_HOME` 时使用用户目录下的 `.dsh`。修改 `dataDirectory` 不自动搬迁已有树文件，迁移前关闭目标宿主并完整备份。

```yaml
- id: session-tree
  config:
    dataDirectory: 'C:/example/session-trees'
    maxRequestBytes: 33554432
```

接口命名空间为 `/_dsh/session-tree`，使用宿主浏览器认证并拒绝跨站修改。客户端传入会话 ID、节点 ID 和修订号，不能指定官方存储文件路径。

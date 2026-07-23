# OpenCode 配置方法

## 安装与升级

AI Console 安装未部署的 OpenCode 时使用官方 npm 包 `opencode-ai`。升级已安装的 OpenCode 时不强制使用 npm，而是调用：

```bash
opencode upgrade <目标版本>
```

OpenCode 会识别原有的 curl、npm、pnpm、bun、brew、choco 或 scoop 安装方式并通过对应渠道升级，避免产生两份安装或 PATH 继续指向旧版本。升级结束后，Agent 会重新执行 `opencode --version`；实际版本与目标版本不一致时任务会标记为失败。该行为需要 AI Console Agent `v2.0.4` 或更高版本。

## 配置文件

配置文件路径：`~/.config/opencode/opencode.json`（或 `opencode.jsonc`）。AI Console 下发配置时会自动创建目录和文件。可使用默认 provider（openai/anthropic/google）或自定义 provider_id。API Key 支持直接配置或通过客户端 `/connect` 命令配置。示例仅供参考，模型与选项可按需调整。

`opencode.json` 示例如下：

```json
{
  "provider": {
    "openai": {
      "options": {
        "baseURL": "https://your-relay.example.com/v1",
        "apiKey": "sk-xxxx"
      },
      "models": {
        "gpt-5.6": {
          "name": "GPT-5.6 (Sol)",
          "limit": {
            "context": 1050000,
            "output": 128000
          },
          "options": {
            "store": false
          },
          "variants": {
            "low": {},
            "medium": {},
            "high": {},
            "xhigh": {},
            "max": {}
          }
        },
        "gpt-5.6-sol": {
          "name": "GPT-5.6 Sol",
          "limit": {
            "context": 1050000,
            "output": 128000
          },
          "options": {
            "store": false
          },
          "variants": {
            "low": {},
            "medium": {},
            "high": {},
            "xhigh": {},
            "max": {}
          }
        },
        "gpt-5.6-terra": {
          "name": "GPT-5.6 Terra",
          "limit": {
            "context": 1050000,
            "output": 128000
          },
          "options": {
            "store": false
          },
          "variants": {
            "low": {},
            "medium": {},
            "high": {},
            "xhigh": {},
            "max": {}
          }
        },
        "gpt-5.6-luna": {
          "name": "GPT-5.6 Luna",
          "limit": {
            "context": 1050000,
            "output": 128000
          },
          "options": {
            "store": false
          },
          "variants": {
            "low": {},
            "medium": {},
            "high": {},
            "xhigh": {},
            "max": {}
          }
        },
        "gpt-5.5": {
          "name": "GPT-5.5",
          "limit": {
            "context": 1050000,
            "output": 128000
          },
          "options": {
            "store": false
          },
          "variants": {
            "low": {},
            "medium": {},
            "high": {},
            "xhigh": {}
          }
        },
        "gpt-5.4": {
          "name": "GPT-5.4",
          "limit": {
            "context": 1050000,
            "output": 128000
          },
          "options": {
            "store": false
          },
          "variants": {
            "low": {},
            "medium": {},
            "high": {},
            "xhigh": {}
          }
        }
      }
    }
  },
  "agent": {
    "build": {
      "options": {
        "store": false
      }
    },
    "plan": {
      "options": {
        "store": false
      }
    }
  },
  "$schema": "https://opencode.ai/config.json"
}
```

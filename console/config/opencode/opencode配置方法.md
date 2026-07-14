配置文件路径：~/.config/opencode/opencode.json（或 opencode.jsonc），不存在需手动创建。可使用默认 provider（openai/anthropic/google）或自定义 provider_id。API Key 支持直接配置或通过客户端 /connect 命令配置。示例仅供参考，模型与选项可按需调整。

opencode.json 如下
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
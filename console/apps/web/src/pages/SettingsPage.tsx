import { useState } from "react"
import { useMutation } from "@tanstack/react-query"
import { Loader2, Key } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { api } from "@/lib/api"

export function SettingsPage() {
  const [oldPwd, setOldPwd] = useState("")
  const [newPwd, setNewPwd] = useState("")
  const [pwdMsg, setPwdMsg] = useState("")

  const changePwdMut = useMutation({
    mutationFn: () => api.changePassword(oldPwd, newPwd),
    onSuccess: () => {
      setPwdMsg("密码已修改，其他设备已下线")
      setOldPwd("")
      setNewPwd("")
    },
    onError: () => setPwdMsg("修改失败，请检查旧密码"),
  })

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">设置</h1>
        <p className="text-sm text-muted-foreground">个人资料</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">修改密码</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <input
            type="password"
            value={oldPwd}
            onChange={(e) => setOldPwd(e.target.value)}
            placeholder="当前密码"
            className="h-9 w-full rounded border border-input bg-background px-3 text-sm"
          />
          <input
            type="password"
            value={newPwd}
            onChange={(e) => setNewPwd(e.target.value)}
            placeholder="新密码（至少 8 位）"
            className="h-9 w-full rounded border border-input bg-background px-3 text-sm"
          />
          <Button
            size="sm"
            disabled={changePwdMut.isPending || !oldPwd || newPwd.length < 8}
            onClick={() => changePwdMut.mutate()}
          >
            {changePwdMut.isPending ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Key className="mr-1 h-3 w-3" />}
            修改密码
          </Button>
          {pwdMsg && <p className="text-xs text-muted-foreground">{pwdMsg}</p>}
        </CardContent>
      </Card>
    </div>
  )
}

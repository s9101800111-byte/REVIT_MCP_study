import { Tool } from "@modelcontextprotocol/sdk/types.js";

/**
 * 網格線（Grid）建立工具。
 *
 * 對應 C# 端 handler: MCP/Core/Commands/CommandExecutor.GridCreate.cs
 * 對應 CommandExecutor.cs cases: create_grids
 */
export const gridTools: Tool[] = [
    {
        name: "create_grids",
        description:
            "依座標（公釐）批次建立直線網格線（軸線），可逐條指定名稱（如 1、2、A、B）。" +
            "與既有網格線共線重疊者會略過（status=duplicate）；名稱已被其他網格線使用者不建立（status=name_conflict）。" +
            "Revit 預設把軸號圓圈放在終點端，需要軸號在哪一端就把該端當 end。" +
            "回傳逐筆 Results（status: created / duplicate / name_conflict / invalid / failed）。",
        inputSchema: {
            type: "object",
            properties: {
                grids: {
                    type: "array",
                    description: "要建立的網格線清單",
                    items: {
                        type: "object",
                        properties: {
                            name: { type: "string", description: "網格線名稱（選填，未填用 Revit 自動編號）" },
                            startX: { type: "number", description: "起點 X（公釐）" },
                            startY: { type: "number", description: "起點 Y（公釐）" },
                            endX: { type: "number", description: "終點 X（公釐）" },
                            endY: { type: "number", description: "終點 Y（公釐）" },
                        },
                        required: ["startX", "startY", "endX", "endY"],
                    },
                },
            },
            required: ["grids"],
        },
    },
];

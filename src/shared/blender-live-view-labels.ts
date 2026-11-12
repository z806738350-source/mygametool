export const blenderLiveViewLabels = {
  en: {
    waiting: "Blender | Waiting for the working scene",
    unavailable: "Blender | Live view unavailable",
    sceneUnavailable: "Blender | Scene update unavailable",
  },
  "zh-CN": {
    waiting: "Blender | 等待工作场景",
    unavailable: "Blender | 实时预览不可用",
    sceneUnavailable: "Blender | 场景更新不可用",
  },
};

export type BlenderLiveViewLanguage = keyof typeof blenderLiveViewLabels;

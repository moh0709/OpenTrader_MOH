import { z, ZodObject } from "zod";
import { zodToJsonSchema, type JsonSchema7Type } from "zod-to-json-schema";
import { BotTemplate } from "@opentrader/bot-processor";
import { templates } from "@opentrader/bot-templates";
import { customStrategies } from "@opentrader/bot-templates/server";
import { xprisma } from "@opentrader/db";
import type { Context } from "../../../../utils/context.js";

type Options = {
  ctx: {
    user: NonNullable<Context["user"]>;
  };
};

type StrategyName = keyof typeof templates | string;
type StrategyInfo = { name: string; schema: JsonSchema7Type; isCustom: boolean } & Pick<
  BotTemplate<any>,
  "displayName" | "description" | "hidden" | "runPolicy" | "watchers" | "requiredHistory"
>;

// Helper function to check if the schema is a ZodObject
function isZodObject(schema: any): schema is ZodObject<any> {
  // Using `instance of ZodObject` will not work because
  // in custom strategies the `z` is imported from a different package
  // TODO: Maybe export the `z` instance to allow importing it as `import { z } from "opentrader";`

  return schema?._def?.typeName === "ZodObject";
}

export async function getStrategies({ ctx }: Options) {
  const strategies: Record<StrategyName, BotTemplate<any>> = {
    ...customStrategies,
    ...templates,
  };

  /**
   * Templates that existing bots are actually running.
   *
   * A hidden strategy is left out of the strategy picker, which is right for one
   * nobody should pick by hand. But the bot edit form drives that same picker
   * from the bot's own template: when the template is hidden there is no option
   * matching it, the select clears itself to null, and the form dies with
   * "Cannot extract strategy schema. Strategy null not found". Grid and DCA bots
   * are created through their own dedicated flows and land on hidden templates,
   * so every one of them was uneditable.
   *
   * A strategy that is in use has to be selectable, otherwise its bots cannot be
   * edited. It stays hidden everywhere else.
   */
  const botsInUse = (await xprisma.bot.findMany({
    where: { ownerId: ctx.user.id },
    select: { template: true },
    distinct: ["template"],
  })) as Array<{ template: string }>;

  const templatesInUse = new Set(botsInUse.map((bot) => bot.template));

  const result: Record<StrategyName, StrategyInfo> = {};
  for (const [strategyName, strategy] of Object.entries(strategies)) {
    const zodSchema = isZodObject(strategy.schema) ? strategy.schema : z.object({});

    result[strategyName] = {
      name: strategyName,
      schema: zodToJsonSchema(zodSchema),
      isCustom: strategyName in customStrategies,
      displayName: strategy.displayName,
      description: strategy.description,
      hidden: !!strategy.hidden && !templatesInUse.has(strategyName),
      runPolicy: strategy.runPolicy,
      watchers: strategy.watchers,
      requiredHistory: strategy.requiredHistory,
    };
  }

  return result;
}

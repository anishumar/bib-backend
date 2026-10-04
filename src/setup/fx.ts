// Which exchange-rate feed a process uses (0345), shared by the API and the
// worker: the config -> adapter mapping, in one place, as `mailerFor` does.
import type { Config } from "../config/config";
import type { Db } from "../db/pool";
import { CurrencyApiFeed, ExchangeRateApiFeed, FirstFeedThatAnswers, NoFeed, fetchText } from "../infrastructure/fx/feeds";
import { PostgresFxRateStore } from "../infrastructure/postgres/fx-rate-repository";
import { FxService } from "../usecase/fx/service";
import type { FxRateFeed } from "../usecase/fx/ports";
import type { Clock } from "../platform/clock";

/** ExchangeRate-API first when there is a key, the Currency API always. */
export function fxFeedFor(cfg: Config): FxRateFeed {
  if (cfg.fx.feed === "off") return new NoFeed();
  const get = fetchText(cfg.fx.timeoutMs);
  const feeds: FxRateFeed[] = [];
  if (cfg.fx.exchangeRateApiKey !== null) feeds.push(new ExchangeRateApiFeed(cfg.fx.exchangeRateApiKey, get));
  feeds.push(new CurrencyApiFeed(get));
  return new FirstFeedThatAnswers(feeds);
}

export function fxServiceFor(cfg: Config, app: Db, clock: Clock): FxService {
  const store = new PostgresFxRateStore(app);
  return new FxService({ feed: fxFeedFor(cfg), rates: store, reporting: store, clock });
}

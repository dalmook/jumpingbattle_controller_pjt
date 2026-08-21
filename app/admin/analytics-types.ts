export type SalesBucket = {
  key: string;
  games: number;
  people: number;
  expected: number;
  revenue: number;
  card: number;
  cash: number;
  account: number;
  deposit: number;
  cancellationFee: number;
  other: number;
  slush: number;
  beverage: number;
  sharedOther: number;
  passes: number;
  gameRevenue: number;
  gameDeposit: number;
  gameCard: number;
  gameCash: number;
  gameAccount: number;
  gameUnclassified: number;
  addOnRevenue: number;
  addOnCard: number;
  addOnCash: number;
  addOnAccount: number;
};

export type AnalyticsResponse = {
  month: string;
  monthSummary: SalesBucket;
  days: SalesBucket[];
  hours: SalesBucket[];
};

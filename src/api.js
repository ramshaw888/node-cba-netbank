// Dependencies
const moment = require('moment-timezone');
const web = require('./web');
const parser = require('./parser');
const Url = require('url');
const debug = require('debug')('node-cba-netbank');

moment.tz.setDefault('Australia/Sydney');

// Constant
const LINK = {
  BASE: 'https://www.my.commbank.com.au',
  LOGON: '/netbank/Logon/Logon.aspx',
  HOME: '/netbank/Portfolio/Home/Home.aspx?RID=:RID&SID=:SID',
  HISTORY: '/netbank/TransactionHistory/History.aspx?RID=:RID&SID=:SID',
  EXPORT: '/netbank/TransactionHistory/Exports.aspx?RID=:RID&SID=:SID&ExportType=OFX',
};

//  Utilities
function toDateString(timestamp) {
  return moment(timestamp).format('DD/MM/YYYY');
}

const isSameTransaction = (left, right) =>
  //  case 1. Have same receipt number, of course, it's not empty
  (left.receiptnumber && left.receiptnumber === right.receiptnumber) ||
  //  case 2. Same time, same description and same amount
  (left.timestamp === right.timestamp && left.description === right.description && left.amount === right.amount);

//  concat 2 transactionList without any duplications.
function concat(a, b) {
  return a.concat(b.filter(vb => !a.find(va => isSameTransaction(va, vb))));
}

//  Return `${LINK.BASE}+${path}`
function getUrl(path) {
  return Url.resolve(LINK.BASE, path);
}

//  Change the BASE link if it's been redirected.
function refreshBase(resp) {
  const oldLink = Url.parse(LINK.BASE);
  const newLink = Url.parse(resp.url);

  if (oldLink.host !== newLink.host) {
    debug(`refreshBase(${oldLink.host} => ${newLink.host}`);
    oldLink.host = newLink.host;
    LINK.BASE = Url.format(oldLink);
  }
  return resp;
}

//  If the search panel is lazy loading, not only the transactions data is not in
//  the page, the search page widget is not ready as well. So, search request will
//  fail. To workaround such problem, we send an update panel partial callback
//  first,let server side prepared the search panel and download transaction.
//  Then, do the real search using the information from the parital callback result.
function lazyLoading(response, account) {
  debug(`lazyLoading(account: ${account.name} [${account.number}] => ${account.available}))`);
  return web
    .post({
      url: getUrl(account.link),
      form: Object.assign({}, response.form, {
        //  Send partial request
        ctl00$ctl00: 'ctl00$BodyPlaceHolder$UpdatePanelForAjax|ctl00$BodyPlaceHolder$UpdatePanelForAjaxh',
        __EVENTTARGET: 'ctl00$BodyPlaceHolder$UpdatePanelForAjax',
        __EVENTARGUMENT: 'doPostBackApiCall|LoadRecentTransactions|false',
      }),
      partial: true,
    })
    .then(parser.parseViewState)
    .then(resp => parser.parseForm(resp).catch(() => resp))
    .then(resp => Object.assign({}, resp, { form: Object.assign({}, response.form, resp.form) }));
}

//  API
function logon(credentials) {
  //  retrieve the logon page
  return (
    web
      .get(getUrl(LINK.LOGON))
      //  Parse the page to get logon form
      .then(refreshBase)
      .then(parser.parseForm)
      .then(resp =>
        //  fill the logon form and submit
        web.post({
          url: getUrl(LINK.LOGON),
          form: Object.assign({}, resp.form, {
            txtMyClientNumber$field: credentials.username,
            txtMyPassword$field: credentials.password,
            chkRemember$field: 'on',
            //  and make JS detector happy
            JS: 'E',
          }),
        }),
      )
      .then(refreshBase)
      //  parse the home page to retrieve the accounts list
      .then(parser.parseHomePage)
  );
}

function getMoreTransactions(response, account) {
  debug(`getMoreTransactions(account: ${account.name} [${account.number}] => ${account.available})`);
  const form = Object.assign({}, response.form, {
    // fill the form
    ctl00$ctl00: 'ctl00$BodyPlaceHolder$UpdatePanelForAjax|ctl00$BodyPlaceHolder$UpdatePanelForAjax',
    __EVENTTARGET: 'ctl00$BodyPlaceHolder$UpdatePanelForAjax',
    __EVENTARGUMENT: 'doPostBackApiCall|LoadTransactions|{"ClearCache":"false","IsSorted":false,"IsAdvancedSearch":true,"IsMonthSearch":false}',
  });
  // send the request
  return web
    .post({
      url: getUrl(account.link),
      form,
      partial: true,
    })
    .then(parser.parseTransactions)
    .then(refreshBase)
    .then((resp) => {
      if (!resp.more || resp.limit) {
        //  There is no more transactions or reached the limit.
        return resp;
      }
      return (
        getMoreTransactions(
          Object.assign({}, resp, { form }),
          Object.assign({}, account, { link: Url.parse(resp.url).path }),
        )
          //  concat more transactions.
          .then(r => Object.assign({}, r, { form, transactions: concat(resp.transactions, r.transactions) }))
          //  Ignore the error as we have got some transactions already
          .catch((error) => {
            debug(error);
            return resp;
          })
      );
    });
}

function getTransactionsByDate(response, account, from, to) {
  debug(
    `getTransactionsByDate(account: ${account.name} [${account.number}] => ${account.available}, from: ${from}, to: ${to})`,
  );
  const form = Object.assign({}, response.form, {
    // fill the form
    ctl00$ctl00: 'ctl00$BodyPlaceHolder$updatePanelSearch|ctl00$BodyPlaceHolder$lbSearch',
    __EVENTTARGET: 'ctl00$BodyPlaceHolder$lbSearch',
    __EVENTARGUMENT: '',
    ctl00$BodyPlaceHolder$searchTypeField: '1',
    ctl00$BodyPlaceHolder$radioSwitchDateRange$field$: 'ChooseDates',
    ctl00$BodyPlaceHolder$dateRangeField: 'ChooseDates',
    ctl00$BodyPlaceHolder$fromCalTxtBox$field: from,
    ctl00$BodyPlaceHolder$toCalTxtBox$field: to,
    //  Add this for partial update
    ctl00$BodyPlaceHolder$radioSwitchSearchType$field$: 'AllTransactions',
  });

  return web
    .post({
      url: getUrl(account.link),
      form,
      partial: true,
    })
    .then(parser.parseTransactions)
    .then(refreshBase)
    .then((resp) => {
      if (!resp.more || resp.limit) {
        //  there is no more transactions or reached the limit.
        return resp;
      }
      //  There are more transactions available.
      return (
        getMoreTransactions(
          Object.assign({}, resp, { form }),
          Object.assign({}, account, { link: Url.parse(resp.url).path }),
        )
          //  concat more transactions.
          .then(r => Object.assign({}, r, { form, transactions: concat(resp.transactions, r.transactions) }))
          .then((r) => {
            debug(`getTransactionsByDate(): getMoreTransactions(): More => ${r.more}, Limit => ${r.limit}`);
            if (r.more && r.limit) {
              //  if there are more transactions, however it reaches limit
              //  we need to send another search request to overcome the limit.
              throw Object.assign(new Error('Reach transations limit'), { response: r });
            }
            return r;
          })
          .catch((error) => {
            //  an error happend during load more, it means that it may have more,
            //  however, some restriction made it stopped, so we call it again,
            //  but this time, we use the eariliest date from the transactions
            //  we retrieved so far as the toDate, so it might workaround this
            //  problem.

            debug(error);

            //  if there is a `response` object attached to `error` object, that means
            //  it's just reach the limit, and contains transations. Otherwise, it don't
            //  have the transactions, a real error, then use previous `resp` instead.
            const r = error.response || resp;
            //  find the earliest date as new 'to' date.
            let timestamp = r.transactions[0].timestamp;
            r.transactions.forEach((t) => {
              if (timestamp > t.timestamp) {
                timestamp = t.timestamp;
              }
            });
            const newTo = toDateString(timestamp);

            // Call self again
            debug(`Call getTransactionsByDate() again with new 'to' date (${to} => ${newTo})`);
            return (
              getTransactionsByDate(
                Object.assign({}, r, { form }),
                Object.assign({}, account, { link: Url.parse(r.url).path }),
                from,
                newTo,
              )
                //  concat more transactions
                .then(rr => Object.assign({}, rr, { form, transactions: concat(r.transactions, rr.transactions) }))
                .catch((err) => {
                  //  cannot call it again, but we got some transactions at least,
                  //  so, just call it a success.
                  debug(err);
                  debug('getTransactionsByDate(): failed to call self again to load more');
                  return Object.assign({}, r, { form, transactions: r.transactions });
                })
            );
          })
      );
    });
}

//  Get transaction history data for given time period.
//
//  * `from`: Default download begin at 6 years ago. FYI, I tried 8 years
//    without getting any error message, however, keep in mind that bank
//    usually only stored 2 years transactions history data.
//  * `to`: Default value is today.
function getTransactionHistory(account, from = toDateString(moment().subtract(6, 'years').valueOf()), to = toDateString(moment().valueOf())) {
  debug(`getTransactionHistory(account: ${account.name} [${account.number}] => ${account.available})`);
  //  retrieve post form and key for the given account
  return web.get(getUrl(account.link)).then(parser.parseTransactionPage).then(refreshBase).then((resp) => {
    const acc = Object.assign({}, account, { link: Url.parse(resp.url).path });
    if (resp.accounts !== null) {
      acc.key = resp.accounts.find(a => a.number === account.number).key;
    }

    //  if the transaction section is lazy loading, we need do a panel update
    //  first, before the real search.
    if (!resp.form.ctl00$BodyPlaceHolder$radioSwitchSearchType$field$) {
      return lazyLoading(resp, acc).then(r => getTransactionsByDate(r, acc, from, to));
    }
    return getTransactionsByDate(resp, acc, from, to).then((r) => {
      debug(`getTransactionHistory(): Total received ${r.transactions.length} transactions.`);
      return r;
    });
  });
}

//  Exports
module.exports = {
  toDateString,
  logon,
  getTransactionHistory,
};

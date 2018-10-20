'use strict';

var _slicedToArray = function () { function sliceIterator(arr, i) { var _arr = []; var _n = true; var _d = false; var _e = undefined; try { for (var _i = arr[Symbol.iterator](), _s; !(_n = (_s = _i.next()).done); _n = true) { _arr.push(_s.value); if (i && _arr.length === i) break; } } catch (err) { _d = true; _e = err; } finally { try { if (!_n && _i["return"]) _i["return"](); } finally { if (_d) throw _e; } } return _arr; } return function (arr, i) { if (Array.isArray(arr)) { return arr; } else if (Symbol.iterator in Object(arr)) { return sliceIterator(arr, i); } else { throw new TypeError("Invalid attempt to destructure non-iterable instance"); } }; }();

// Dependencies
const Promise = require('bluebird');
const cheerio = require('cheerio');
const moment = require('./moment');
const debug = require('debug')('node-cba-netbank');
const util = require('util');

//  Constants
const submittableSelector = 'input,select,textarea,keygen';
const rCRLF = /\r?\n/g;

//  Utilities
//  reference: https://github.com/cheeriojs/cheerio/blob/master/lib/api/forms.js
//  Add support for allow `disabled` and `button` input element in the serialized array.
function serializeArray(element, options = { disabled: false, button: false }) {
  // Resolve all form elements from either forms or collections of form elements
  return element.map((i, elem) => {
    const $elem = cheerio(elem);
    if (elem.name === 'form') {
      return $elem.find(submittableSelector).toArray();
    }
    return $elem.filter(submittableSelector).toArray();
  })
  // Verify elements have a name (`attr.name`)
  // and are not disabled (`:disabled`) if `options.disabled === false`
  // and cannot be clicked (`[type=submit]`) if `options.button === true`
  // are used in 'x-www-form-urlencoded' ('[type=file]')
  // and are either checked/don't have a checkable state
  // Convert each of the elements to its value(s)
  .filter(`[name!=""]${options.disabled ? '' : ':not(:disabled)'}:not(${options.button ? '' : ':submit, :button, '}:image, :reset, :file):matches([checked], :not(:checkbox, :radio))`).map((i, elem) => {
    const $elem = cheerio(elem);
    const name = $elem.attr('name');
    let value = $elem.val();

    // If there is no value set (e.g. `undefined`, `null`), then default value to empty
    if (value == null) {
      value = $elem.attr('type') === 'checkbox' ? 'on' : '';
    }

    // If we have an array of values (e.g. `<select multiple>`),
    // return an array of key/value pairs
    if (Array.isArray(value)) {
      return value.map(val => ({ name, value: val.replace(rCRLF, '\r\n') })); //   These can occur inside of `<textarea>'s` // to guarantee consistency across platforms // We trim replace any line endings (e.g. `\r` or `\r\n` with `\r\n`)
      // Otherwise (e.g. `<input type="text">`, return only one key/value pair
    }
    return { name, value: value.replace(rCRLF, '\r\n') };

    // Convert our result to an array
  }).get();
}

//  parse the balance to a double number.
//  e.g. '$1,766.50 CR', '$123.00 DR'
//  Positive is CR, and negative is DR.
function parseCurrencyText(text) {
  let amount = Number(text.replace(/[^0-9.]+/g, ''));
  if (text.indexOf('DR') > -1) {
    amount = -amount;
  }
  return amount;
}

//  Parse:
// <div class="FieldElement FieldElementLabel FieldElementNoLabel">
//   <span class="CurrencySymbol CurrencyLabel PreFieldText">$</span>
//   <span title="$" class="Currency field WithPostFieldText">1,767.44</span>
//   <span class="PostFieldText">CR</span>
// </div>
//  to Number `1767.44`.
function parseCurrencyHtml(elem) {
  const e = cheerio.load(`<div>${elem}</div>`);
  const currency = parseFloat(e('.Currency').text().replace(/,/g, '').trim());
  if (e('.PostFieldText').text().trim() === 'DR') {
    return -currency;
  }
  return currency;
}

// Transaction format
// {
//  timestamp,
//  date,
//  description,
//  amount,
//  balance,
//  trancode,
//  receiptnumber
// }
function parseTransaction(json) {
  try {
    //  try parse the date from 'Date.Sort[1]' first
    const dateTag = json.Date.Sort[1];
    let t = moment.utc(dateTag, 'YYYYMMDDHHmmssSSS').tz('Australia/Sydney');
    if (!t.isValid()) {
      //  try parse the date from 'Date.Text' if previous attempt failed
      t = moment(json.Date.Text, 'DD MMM YYYY');
      //  use sort order to distinguish different transactions.
      if (dateTag && !Number.isNaN(+dateTag)) {
        t.millisecond(+dateTag);
      }
    }

    return {
      timestamp: t.valueOf(),
      date: t.format(),
      //  replace newline with '; '
      description: json.Description.Text.replace(/\n/g, '; '),
      amount: parseCurrencyText(json.Amount.Text),
      balance: parseCurrencyText(json.Balance.Text),
      trancode: json.TranCode.Text || '',
      receiptnumber: json.ReceiptNumber.Text || ''
    };
  } catch (err) {
    //  ignore the error for the misformatted transaction, and return null.
    debug(err);
    debug(`Cannot parse the given transaction: ${JSON.stringify(json)}`);
    return null;
  }
}

// Parsers

function parseTitle(resp) {
  return new Promise(resolve => {
    const $ = cheerio.load(resp.body);
    const contentType = resp.headers['content-type'];
    if (contentType && contentType.indexOf('text/html') >= 0) {
      const m = /NetBank - ([^-]+)/.exec($('title').text());
      if (m) {
        const title = m[1].trim();
        debug(`parseTitle(): found title => '${title}'`);
        return resolve(Object.assign({}, resp, { title }));
      }
    }
    debug('parseTitle(): cannot find title');
    return resolve(resp);
  });
}

function parseForm(resp) {
  return new Promise((resolve, reject) => {
    const $ = cheerio.load(resp.body);
    const form = {};
    serializeArray($('form'), { disabled: true, button: true }).forEach(item => {
      form[item.name] = item.value;
    });

    if (Object.keys(form).length === 0) {
      return reject(new Error('parseForm(): Cannot find form.'));
    }

    return resolve(Object.assign({}, resp, { form: Object.assign({}, resp.form, form) }));
  });
}

function parseViewState(resp) {
  return new Promise(resolve => {
    const form = Object.assign({}, resp.form);
    //  get new view state of asp.net
    const REGEX_VIEW_STATE = /(__VIEWSTATE|__EVENTVALIDATION|__VIEWSTATEGENERATOR)\|([^|]+)\|/g;
    let match = REGEX_VIEW_STATE.exec(resp.body);
    while (match) {
      var _match = match,
          _match2 = _slicedToArray(_match, 3);

      const key = _match2[1],
            value = _match2[2];

      form[key] = value;
      match = REGEX_VIEW_STATE.exec(resp.body);
    }
    return resolve(Object.assign({}, resp, { form: Object.assign({}, resp.form, form) }));
  });
}

//  Account format:
// {
//  name,
//  link,
//  bsb,
//  account,
//  number: {bsb+account}
//  balance
// }
function parseAccountList(resp) {
  return new Promise((resolve, reject) => {
    const $ = cheerio.load(resp.body);
    const accountRows = $('.main_group_account_row');

    if (!accountRows || accountRows.length === 0) {
      return reject(new Error('Cannot find account list.'));
    }

    const accounts = [];
    accountRows.each((index, elem) => {
      try {
        const $$ = cheerio.load(elem);
        const account = {
          name: $$('.NicknameField .left a').text().trim(),
          link: $$('.NicknameField .left a').attr('href'),
          bsb: $$('.BSBField .text').text().replace(/\s+/g, '').trim(),
          account: $$('.AccountNumberField .text').text().replace(/\s+/g, '').trim(),
          balance: parseCurrencyHtml($$('.AccountBalanceField')),
          available: parseCurrencyHtml($$('.AvailableFundsField'))
        };
        //  Assemble the `bsb` and `account` to construct `number`
        account.number = `${account.bsb}${account.account}`;
        account.type = `${/ACCOUNT_PRODUCT_TYPE=(\w+)/.exec(account.link)[1]}`;
        //  push to the final account list if it's valid
        if (account.name && account.link && account.account) {
          accounts.push(account);
        }
      } catch (err) {
        debug(`parseAccountList(): ${err}`);
        debug(`parseAccountList(): elem => ${util.inspect(elem)}`);
      }
    });

    debug(`parseAccountList(): found ${accounts.length} accounts`);
    return resolve(Object.assign({}, resp, { accounts }));
  });
}

function parseHomePage(resp) {
  return parseForm(resp).then(parseTitle).then(parseAccountList);
}

function parseTransactions(resp) {
  return new Promise((resolve, reject) => {
    //  Get transactions
    const m = /({"Transactions":(?:.+)})\);/.exec(resp.body);
    let transactions;
    if (m) {
      const json = JSON.parse(m[1]);
      const pendings = json.OutstandingAuthorizations.map(parseTransaction).filter(v => !!v);
      debug(`parseTransactions(): found ${pendings.length} pending transactions`);
      transactions = json.Transactions.map(parseTransaction).filter(v => !!v);
      debug(`parseTransactions(): found ${transactions.length} transactions`);
      debug(`parseTransactions(): There ${json.More ? 'are ' : 'is NO '}more transactions.`);
      if (json.Limit) {
        debug('parseTransactions(): However, it reaches the limit.');
      }
      return resolve(Object.assign({}, resp, {
        transactions,
        more: json.More,
        limit: json.Limit,
        pendings
      }));
    }
    return reject(new Error('Cannot find transactions in the resp'));
  });
}

//  Parse the account list from TransactionHistory/History.aspx page
// AccountWithKeys
// {
//  name,
//  number,
//  key
// }
function parseAccountListWithKeys(resp) {
  return new Promise((resolve, reject) => {
    const $ = cheerio.load(resp.body);
    const accounts = [];

    $('#ctl00_ContentHeaderPlaceHolder_updatePanelAccount').find('option').each((i, e) => {
      const texts = $(e).text().split('|').map(t => t.trim());
      if (texts.length === 2) {
        const acc = {
          name: texts[0],
          number: texts[1].replace(/\s+/g, ''),
          key: $(e).attr('value')
        };
        if (acc.key && acc.number && acc.name) {
          accounts.push(acc);
        }
      }
    });

    if (accounts.length > 0) {
      resolve(Object.assign({}, resp, { accounts }));
    } else {
      reject(new Error('Cannot find accounts keys'));
    }
  });
}

function parseTransactionPage(resp) {
  return parseForm(resp).then(parseTitle).then(parseTransactions).then(parseAccountListWithKeys);
}

module.exports = {
  serializeArray,
  parseTitle,
  parseForm,
  parseViewState,
  parseAccountList,
  parseHomePage,
  parseCurrencyText,
  parseCurrencyHtml,
  parseTransaction,
  parseTransactions,
  parseAccountListWithKeys,
  parseTransactionPage
};
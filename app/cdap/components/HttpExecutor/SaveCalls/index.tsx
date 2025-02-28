/*
 * Copyright © 2020 Cask Data, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not
 * use this file except in compliance with the License. You may obtain a copy of
 * the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
 * WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
 * License for the specific language governing permissions and limitations under
 * the License.
 */

import * as React from 'react';

import HttpExecutorActions from 'components/HttpExecutor/store/HttpExecutorActions';
import Switch from '@material-ui/core/Switch';
import { connect } from 'react-redux';

const mapStateToProps = (state) => {
  return {
    saveCalls: state.http.saveCalls,
  };
};

const mapDispatch = (dispatch) => {
  return {
    toggleSaveCalls: () => {
      dispatch({
        type: HttpExecutorActions.toggleSaveCalls,
      });
    },
  };
};

interface ISaveCallsProps {
  saveCalls: boolean;
  toggleSaveCalls: () => void;
}

const SaveCallsView: React.FC<ISaveCallsProps> = ({ saveCalls, toggleSaveCalls }) => {
  return (
    <div>
      <Switch
        checked={saveCalls}
        onChange={() => toggleSaveCalls()}
        data-cy="save-mode-btn"
        color="primary"
        name="checkedB"
        inputProps={{ 'aria-label': 'primary checkbox' }}
        data-testid="save-mode-btn"
      />
      Save calls
    </div>
  );
};

const SaveCalls = connect(mapStateToProps, mapDispatch)(SaveCallsView);
export default SaveCalls;

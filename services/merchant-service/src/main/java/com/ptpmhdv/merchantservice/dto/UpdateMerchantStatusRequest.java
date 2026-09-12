package com.ptpmhdv.merchantservice.dto;

import com.ptpmhdv.merchantservice.model.MerchantStatus;
import jakarta.validation.constraints.NotNull;
import lombok.Data;

@Data
public class UpdateMerchantStatusRequest {

    @NotNull(message = "status is required")
    private MerchantStatus status;
}
